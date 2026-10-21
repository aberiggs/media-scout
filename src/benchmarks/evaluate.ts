import { z } from 'zod';
import type { LLMClient } from '../clients/llm';
import { Picker, type Candidate } from '../core/picker';
import { Planner } from '../core/planner';
import { QueueAssociator } from '../core/queue-association';
import { parseReleaseTitle, parseReleaseCoverage } from '../core/parser';
import { isGrabbable, verifyRelease, verifyGroupCoverage } from '../core/guardrails';
import type { WorkUnit } from '../core/watcher';
import type { AssociationRequest, GroupCandidate, PlanningContext, WorkGroup } from '../core/group-types';
import { BenchmarkTextSchema, type DatasetCaseSchema } from './contracts';
import type { Release } from '../types/prowlarr';

export const benchmarkTracks = ['plan-single', 'plan-group', 'pick-single', 'pick-group', 'association', 'replay'] as const;
export type BenchmarkTrack = typeof benchmarkTracks[number];
export interface BenchmarkOutcome {
  caseId: string; track: BenchmarkTrack;
  status: 'correct' | 'incorrect' | 'justified-abstention' | 'avoidable-abstention' | 'uncertain' | 'unsafe-proposal' | 'validator-rejected' | 'provider-failure' | 'unsupported-retrieval' | 'retrieval-unavailable';
  unsafe: boolean; validatorRejected: boolean; selectedIds: string[]; rawIndices: number[];
  failure: 'schema' | 'provider' | 'semantic' | null;
  queries: Array<{ query: string; categories: number[]; targetIndices?: number[]; episodeTargets?: Array<{ targetIndex: number; episodeIndices: number[] }> }>;
  supportedQueryCount: number; unsupportedQueryCount: number;
  admittedIds: string[]; retrievedIds: string[]; cappedIds: string[];
  admissionLossIds: string[]; capLossIds: string[]; poolRecall: number | null;
  reviewedCandidates: number; uncertainCandidates: number;
  association: 'matched' | 'unrelated' | 'uncertain' | null;
  malformedProposal: boolean;
  identityCorrect: boolean | null;
  claimedTargetCoverage: number | null;
  selectionCoverageBasis: 'explicit' | 'inferred' | 'mixed' | 'unknown';
  preferenceCredit: number | null;
}
type Case = z.infer<typeof DatasetCaseSchema>;
type Query = { query: string; categories: number[]; indexers: string[]; limit: number };
const empty = (c: Case, track: BenchmarkTrack): BenchmarkOutcome => ({ caseId: c.id, track, status: 'provider-failure', unsafe: false, validatorRejected: false, selectedIds: [], rawIndices: [], failure: null, queries: [], supportedQueryCount: 0, unsupportedQueryCount: 0, admittedIds: [], retrievedIds: [], cappedIds: [], admissionLossIds: [], capLossIds: [], poolRecall: null, reviewedCandidates: c.candidates.filter(r => r.review && r.review.selection !== 'uncertain').length, uncertainCandidates: c.candidates.filter(r => !r.review || r.review.selection === 'uncertain').length, association: null, malformedProposal: false, identityCorrect: null, claimedTargetCoverage: null, selectionCoverageBasis: 'unknown', preferenceCredit: null });
const equalSet = <T extends string | number>(a: T[], b: T[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Exact request replay only; category/indexer order is set-equivalent. */
export function frozenQuery(c: Case, request: Query) {
  return c.queries.find(q => q.query === request.query && equalSet(q.categories, request.categories) && equalSet(q.indexers, request.indexers) && q.limit === request.limit);
}
export function benchmarkUnit(c: Case): WorkUnit {
  if (!knownMapping(c)) throw new Error('benchmark identity or season mapping is unknown');
  const movie = c.input.kind === 'movie';
  const externalId = Number(c.input.externalId!.split(':').at(-1));
  return { key: `${c.id}:0`, kind: movie ? 'movie' : 'tv', arr: movie ? 'radarr' : 'sonarr', serviceId: 1, externalId, title: c.input.title, altTitles: c.input.altTitles, ...(c.input.year === null ? {} : { year: c.input.year }), ...(movie ? {} : { seriesType: c.input.kind === 'anime' ? 'anime' as const : 'standard' as const, season: { seasonNumber: c.input.seasonNumber!, missing: c.input.episodes.map((e, i) => ({ episodeId: i + 1, ...e })) } }) };
}
function knownMapping(c: Case): boolean {
  const prefix = c.input.kind === 'movie' ? 'tmdb' : 'tvdb';
  return new RegExp(`^${prefix}:[1-9]\\d*$`).test(c.input.externalId ?? '') && Number.isSafeInteger(Number(c.input.externalId?.split(':').at(-1))) && (c.input.kind === 'movie' || c.input.seasonNumber !== null);
}
function release(c: Case, i: number): Release {
  const x = c.candidates[i]!;
  const id = (kind: string) => Number(x.externalIds.find(id => id.startsWith(`${kind}:`))?.split(':')[1]) || null;
  return { guid: `benchmark:${x.id}`, age: x.age ?? 0, size: x.size, files: null, grabs: x.grabs, indexerId: 1, indexer: x.source, subGroup: null, title: x.title, tvdbId: id('tvdb'), tmdbId: id('tmdb'), publishDate: '', downloadUrl: x.downloadPresent ? 'benchmark:unreachable' : null, indexerFlags: [], categories: x.categories.map(id => ({ id, name: '' })), magnetUrl: x.magnetPresent ? 'benchmark:unreachable' : null, infoHash: null, seeders: x.seeders, leechers: x.leechers, protocol: x.protocol === 'torrent' || x.protocol === 'usenet' ? x.protocol : 'unknown', downloadClientId: null };
}
function associationRequest(c: Case, unit: WorkUnit): AssociationRequest {
  const expected = c.candidates.find(r => c.label.acceptableCandidateIds.includes(r.id));
  return { arr: unit.arr, sourceJobKey: 'synthetic-job', materialSignature: 'synthetic-material', contextSignature: 'synthetic-context', promptVersion: 'queue-association-v2',
    queue: [{ queueIndex: 0, title: c.queueTitle ?? (c.label.selection === 'uncertain' && !expected ? 'Ambiguous download' : expected?.title ?? c.input.title), status: 'downloading', trackedStatus: null, trackedState: null }],
    media: [{ mediaIndex: 0, kind: unit.kind, title: unit.title, year: unit.year ?? null, seriesType: unit.seriesType ?? null, seasonNumbers: unit.season ? [unit.season.seasonNumber] : [] }],
    targets: [{ targetIndex: 0, kind: unit.kind, title: unit.title, seriesType: unit.seriesType ?? null, seasonNumber: unit.season?.seasonNumber ?? null, expectedTargets: (unit.season?.missing ?? []).map(e => ({ description: e.title, seasonNumber: unit.season!.seasonNumber, episodeNumber: e.episodeNumber, absoluteEpisodeNumber: e.absoluteEpisodeNumber })) }],
    lookup: { queueRefsByIndex: ['synthetic-queue'], mediaReferencesByIndex: [{ arr: unit.arr, serviceId: unit.serviceId, externalId: unit.externalId }], workReferencesByIndex: [{ workKey: unit.key, arr: unit.arr, serviceId: unit.serviceId, externalId: unit.externalId, seasonNumber: unit.season?.seasonNumber ?? null }], workUnitsByIndex: [unit] } };
}
function safeQuery(query: string): boolean { return query.length <= 300 && BenchmarkTextSchema.safeParse(query).success; }
function grounded(c: Case, query: string): boolean {
  const normalize = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const titleGrounded = [c.input.title, ...c.input.altTitles].some(t => {
    if (normalize(query).includes(normalize(t))) return true;
    const distinctive = normalize(t).trim().split(' ').find(w => w.length >= 4 && !['the', 'part', 'beyond'].includes(w));
    return distinctive !== undefined && normalize(query).includes(` ${distinctive} `);
  });
  const seasons = [...query.matchAll(/\bS(\d{1,2})(?=\b|E)/gi)].map(m => Number(m[1]));
  seasons.push(...[...query.matchAll(/\bSeason\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/gi)].map(m => Number(m[1] ?? m[2])));
  const localEpisodes = new Set(c.input.episodes.map(e => e.episodeNumber));
  const scopedEpisodes = [...query.matchAll(/\bS\d{1,2}((?:E\d{1,4})+)/gi)].flatMap(m => [...m[1]!.matchAll(/E(\d+)/gi)].map(e => Number(e[1])));
  scopedEpisodes.push(...[...query.matchAll(/\bS\d{1,2}E\d+\s*-\s*(?:E)?(\d+)\b/gi)].map(m => Number(m[1])));
  scopedEpisodes.push(...[...query.matchAll(/\bSeason\s*\d+\s*(?:Episode|Ep)\s*(\d+)\b/gi)].map(m => Number(m[1])));
  const supplied = new Set([c.input.year, c.input.seasonNumber, ...c.input.episodes.flatMap(e => [e.episodeNumber, e.absoluteEpisodeNumber]), ...[c.input.title, ...c.input.altTitles].flatMap(t => [...t.matchAll(/\d+/g)].map(m => Number(m[0])))]);
  for (const [number, word] of ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].entries()) if ([c.input.title, ...c.input.altTitles].some(t => normalize(t).includes(` ${word} `))) supplied.add(number);
  const numbersGrounded = [...query.matchAll(/\d+/g)].every(m => supplied.has(Number(m[0])));
  return safeQuery(query) && titleGrounded && numbersGrounded && seasons.every(s => s === c.input.seasonNumber) && scopedEpisodes.every(e => localEpisodes.has(e));
}

/** Decision-only evaluation. No State, Runner, service clients, timers or transport capability. */
export async function evaluateBenchmarkCase(c: Case, track: BenchmarkTrack, llm: LLMClient): Promise<BenchmarkOutcome> {
  const out = empty(c, track);
  if (!knownMapping(c)) { out.status = 'uncertain'; return out; }
  if (c.held) { out.status = 'justified-abstention'; return out; }
  if (track.startsWith('pick-') && c.queries.length > 0 && c.queries.every(q => q.availability === 'unavailable')) { out.status = 'retrieval-unavailable'; return out; }
  const unit = benchmarkUnit(c);
  const group: WorkGroup = { key: c.id, members: [], targets: [unit], dueTargetIndices: [0] };
  const observedAt = c.queries[0]?.observedAt ?? '2026-10-21T02:00:00.000Z';
  const context: PlanningContext = { openWork: [], activeDownloads: [], sourceKnowledge: [{ arr: unit.arr, library: { kind: 'known', observedAt }, queue: { kind: 'known', observedAt } }] };
  let raw: unknown;
  let received = false;
  // Tap before schema and semantic validation, retaining raw proposals in memory
  // only. Never persist reasons, raw provider bodies, or untrusted arbitrary keys.
  const observed: LLMClient = { json: args => llm.json({ ...args, schema: z.unknown().transform(value => { raw = value; received = true; return args.schema.parse(value); }) }) };
  let available = c.candidates;
  const recordRawIndices = () => {
    if (typeof raw !== 'object' || raw === null) return;
    const obj = raw as { verdict?: unknown; releaseIndex?: unknown; selection?: { releaseIndices?: unknown } };
    if (obj.verdict === 'grab') {
      if (typeof obj.releaseIndex === 'number' && Number.isSafeInteger(obj.releaseIndex)) out.rawIndices = [obj.releaseIndex];
      else out.malformedProposal = true;
    }
    if (Array.isArray(obj.selection?.releaseIndices)) {
      out.malformedProposal = obj.selection.releaseIndices.some(v => typeof v !== 'number' || !Number.isSafeInteger(v)) || obj.selection.releaseIndices.length > 3;
      out.rawIndices = obj.selection.releaseIndices.filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v)).slice(0, 3);
    }
  };
  try {
    if (track.startsWith('plan-') || track === 'replay') {
      out.queries = track === 'plan-group' ? await new Planner({ llm: observed }).planGroup({ group, context, ...(unit.kind === 'tv' ? { stage: (unit.season?.missing.length ?? 0) >= 3 ? 'pack-batch' : 'episodes' } : {}) }) : await new Planner({ llm: observed }).plan(unit);
      const scope = c.queries[0];
      const supported = out.queries.map(q => scope ? frozenQuery(c, { ...q, indexers: scope.indexers, limit: scope.limit }) : undefined);
      out.supportedQueryCount = supported.filter(Boolean).length; out.unsupportedQueryCount = supported.filter(q => !q).length;
      out.unsafe = out.queries.some(q => !grounded(c, q.query));
      // Unsafe request text is not published back into artifacts.
      out.queries = out.queries.filter(q => safeQuery(q.query));
      if (track !== 'replay') { out.status = out.unsafe ? 'unsafe-proposal' : 'correct'; return out; }
      if (out.unsafe) { out.status = 'unsafe-proposal'; return out; }
      if (out.unsupportedQueryCount) { out.status = 'unsupported-retrieval'; return out; }
      if (supported.some(q => q?.availability !== 'success')) { out.status = 'retrieval-unavailable'; return out; }
      const ids = new Set(supported.flatMap(q => q?.candidateIds ?? []));
      available = [...ids].flatMap(id => { const r = c.candidates.find(r => r.id === id); return r ? [r] : []; });
      const denominator = c.label.acceptableCandidateIds.length;
      out.poolRecall = denominator ? [...ids].filter(id => c.label.acceptableCandidateIds.includes(id)).length / denominator : null;
      received = false; raw = undefined;
    }
    if (track === 'association') {
      const request = associationRequest(c, unit);
      if (c.associationExpectation === 'uncertain') {
        request.media.push({ ...request.media[0]!, mediaIndex: 1, year: (unit.year ?? 2024) + 1 });
        request.lookup.mediaReferencesByIndex.push({ arr: unit.arr, serviceId: 2, externalId: unit.externalId + 1 });
      }
      const decisions = await new QueueAssociator({ llm: observed }).associate(request);
      out.association = decisions[0]?.outcome ?? null;
      const ambiguous = c.associationExpectation === 'uncertain' || !c.label.acceptableCandidateIds.length && c.label.selection === 'uncertain';
      if (ambiguous) { out.unsafe = out.association === 'matched'; out.status = out.unsafe ? 'unsafe-proposal' : 'justified-abstention'; }
      else if (c.associationExpectation === 'unrelated') { out.unsafe = out.association === 'matched'; out.status = out.unsafe ? 'unsafe-proposal' : out.association === 'unrelated' ? 'correct' : 'justified-abstention'; }
      else out.status = out.association === 'matched' ? 'correct' : 'avoidable-abstention';
      return out;
    }
    out.retrievedIds = available.map(r => r.id);
    const candidates: Array<{ id: string; single: Candidate; grouped: GroupCandidate }> = [];
    for (const r of available) {
      const index = c.candidates.indexOf(r), rel = release(c, index);
      if (!isGrabbable(rel)) continue;
      const checked = verifyRelease({ unit, release: rel, parsed: parseReleaseTitle(rel.title) });
      const grouped = verifyGroupCoverage({ originalUnits: [unit], actionableUnits: [unit], parsed: parseReleaseCoverage(rel.title) });
      if (track === 'pick-group' ? grouped.kind !== 'covered' : !checked.ok) continue;
      const capture = grouped.kind === 'covered' ? grouped : null;
      candidates.push({ id: r.id, single: { release: rel, coveredEpisodes: checked.ok && checked.kind === 'tv' ? checked.covered : null, coverageBasis: checked.ok && checked.kind === 'tv' ? checked.coverageBasis : null },
        grouped: { release: rel, physicalSlot: index, parsed: parseReleaseCoverage(rel.title), capture: capture?.capture ?? [], requestedFootprint: capture?.requestedFootprint ?? [], extraSeasons: capture?.extraSeasons ?? [] } });
    }
    // Same coverage-diversity then seeders ordering as automatic grouped picking.
    const ordered: typeof candidates = [], remaining = [...candidates], covered = new Set<number>();
    while (remaining.length) {
      remaining.sort((a, b) => {
        const score = (x: typeof a) => x.grouped.capture.reduce((n, v) => n + (v.episodeIds?.filter(id => !covered.has(id)).length ?? 1), 0);
        return (track === 'pick-group' ? score(b) - score(a) : 0) || (b.single.release.seeders ?? -1) - (a.single.release.seeders ?? -1);
      });
      const next = remaining.shift()!; ordered.push(next);
      for (const v of next.grouped.capture) for (const id of v.episodeIds ?? []) covered.add(id);
    }
    out.admittedIds = ordered.map(r => r.id); out.cappedIds = out.admittedIds.slice(0, 100);
    out.admissionLossIds = out.retrievedIds.filter(id => !out.admittedIds.includes(id)); out.capLossIds = out.admittedIds.slice(100);
    const bounded = ordered.slice(0, 100);
    const abstention = () => c.label.acceptableCandidateIds.some(id => out.cappedIds.includes(id)) ? 'avoidable-abstention' as const : 'justified-abstention' as const;
    if (!bounded.length) { out.status = abstention(); return out; }
    let grab = false;
    try {
      if (track === 'pick-group') {
        const verdict = await new Picker({ llm: observed }).pickGroup({ group, context, candidates: bounded.map(r => r.grouped) });
        grab = verdict.verdict === 'grab';
      } else {
        const verdict = await new Picker({ llm: observed }).pick({ unit, candidates: bounded.map(r => r.single) });
        grab = verdict.verdict === 'grab';
      }
    } finally { recordRawIndices(); }
    if (!grab) { out.status = abstention(); return out; }
    out.selectedIds = out.rawIndices.flatMap(i => bounded[i] ? [bounded[i]!.id] : []);
    const selected = out.selectedIds.map(id => c.candidates.find(r => r.id === id)!);
    if (selected.length && selected.every(r => r.review?.preferenceTier !== undefined)) out.preferenceCredit = selected.reduce((n, r) => n + 1 / (1 + r.review!.preferenceTier!), 0) / selected.length;
    out.identityCorrect = selected.some(r => !r.review || r.review.identity === 'unresolved') ? null : selected.every(r => r.review?.identity === 'compatible');
    const bases = new Set(selected.map(r => r.review?.coverageBasis ?? 'unknown'));
    out.selectionCoverageBasis = bases.has('unknown') ? 'unknown' : bases.size > 1 ? 'mixed' : bases.has('inferred') ? 'inferred' : 'explicit';
    if (out.selectionCoverageBasis !== 'unknown') {
      const covered = new Set(selected.flatMap(r => r.review?.coveredEpisodeNumbers ?? []));
      out.claimedTargetCoverage = unit.kind === 'movie' ? Number(out.identityCorrect === true) : c.input.episodes.filter(e => covered.has(e.episodeNumber)).length / Math.max(1, c.input.episodes.length);
    }
    out.unsafe = selected.some(r => r.review?.identity === 'wrong' || r.review?.selection === 'unacceptable');
    out.status = out.unsafe ? 'unsafe-proposal' : selected.some(r => !r.review || r.review.selection === 'uncertain') ? 'uncertain' : out.selectedIds.every(id => c.label.acceptableCandidateIds.includes(id)) && out.selectedIds.length > 0 ? 'correct' : 'incorrect';
    if (out.status !== 'correct') out.preferenceCredit = null;
    return out;
  } catch (error) {
    recordRawIndices();
    out.validatorRejected = received;
    out.failure = error instanceof z.ZodError ? 'schema' : received ? 'semantic' : 'provider';
    const invalidReference = out.rawIndices.some(i => i < 0 || i >= out.cappedIds.length) || new Set(out.rawIndices).size !== out.rawIndices.length;
    out.unsafe = received && (out.malformedProposal || invalidReference || out.failure === 'semantic');
    out.status = received ? 'validator-rejected' : 'provider-failure';
    return out;
  }
}

/** Network-free entry point: it constructs its own recorded-output client. */
export function evaluateRecordedCase(c: Case, track: BenchmarkTrack, outputs: readonly unknown[]): Promise<BenchmarkOutcome> {
  let index = 0;
  return evaluateBenchmarkCase(c, track, { async json(args) {
    if (index >= outputs.length) throw new Error('recorded output unavailable');
    return args.schema.parse(structuredClone(outputs[index++]));
  } });
}
