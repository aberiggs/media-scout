import { z } from 'zod';
import { createHash } from 'node:crypto';
import { searchRequestSchema, type SearchRequest } from './contracts';

const nonempty = z.string().trim().min(1);
export const agentRequestSchema = z.object({
  version: z.literal(1),
  prompt: nonempty.max(4000),
  kind: z.enum(['movie', 'show', 'unspecified']),
  scope: z.enum(['movie', 'episode', 'season', 'multi-season', 'unspecified']),
  titles: z.array(nonempty),
  year: z.number().int().optional(),
  externalIds: z.record(nonempty, z.union([nonempty, z.number().int().nonnegative()])),
  intents: z.array(z.object({
    id: nonempty,
    type: z.enum(['movie', 'episode', 'season']),
    season: z.number().int().nonnegative().optional(),
    episode: z.number().int().positive().optional(),
    absoluteEpisode: z.number().int().positive().optional(),
    title: nonempty.optional(),
    airDate: z.string().optional(),
  }).strict()),
  targetIds: z.array(nonempty),
  arrTargetIds: z.array(nonempty).max(200),
  context: z.array(nonempty),
  contextEpisodes: z.array(z.object({
    id: nonempty, season: z.number().int().nonnegative().optional(), episode: z.number().int().positive().optional(),
    absoluteEpisode: z.number().int().positive().optional(), title: nonempty.optional(),
    airDate: z.string().optional(), contextReason: nonempty,
    hasFile: z.boolean(), queued: z.boolean(), monitored: z.boolean(), available: z.boolean(),
  }).strict()),
  showMetadata: z.object({ originalLanguage: nonempty.optional(), seriesType: z.enum(['standard', 'anime', 'daily']).optional(), episodeTitle: nonempty.optional(), profile: z.record(z.string(), z.unknown()).optional() }).strict(),
  preferences: z.record(z.string(), z.unknown()),
}).strict();
export type AgentRequest = z.infer<typeof agentRequestSchema>;

export function normalizeAgentRequest(raw: SearchRequest): AgentRequest {
  const request = searchRequestSchema.parse(raw);
  const context = request.context;
  const numbering = ['seasonNumber', 'episodeNumber', 'absoluteEpisodeNumber'] as const;
  for (const target of context?.targets ?? []) for (const key of numbering) {
    const scopeValue = context?.scope?.[key], targetValue = target[key];
    if (scopeValue !== undefined && targetValue !== undefined && scopeValue !== targetValue)
      throw new Error(`Request scope conflicts with target ${key}`);
  }
  const useScopeNumbering = (context?.targets?.length ?? 0) === 1;
  return agentRequestSchema.parse({
    version: 1,
    prompt: request.prompt,
    kind: context?.kind === 'movie' ? 'movie' : context?.kind === 'tv' ? 'show' : 'unspecified',
    scope: context?.scope?.type === 'movie' ? 'movie'
      : context?.targets && new Set(context.targets.map(target => target.seasonNumber).filter((value): value is number => value !== undefined)).size > 1 ? 'multi-season'
      : context?.scope?.type === 'episode' || context?.scope?.type === 'episode-set' ? 'episode'
      : context?.scope?.type === 'season' ? 'season'
      : context?.scope?.type === 'unspecified' && (context?.targets?.length ?? 0) === 0 ? 'unspecified'
      : context?.targets?.some(target => target.seasonNumber !== undefined) ? 'season' : 'unspecified',
    titles: context?.titles ?? [],
    ...(context?.year === undefined ? {} : { year: context.year }),
    externalIds: context?.externalIds ?? {},
    intents: (context?.targets ?? []).map(target => ({
      id: target.targetId,
      type: context?.scope?.type === 'movie' ? 'movie' : context?.scope?.type === 'season' ? 'season' : 'episode',
      ...((target.seasonNumber ?? (useScopeNumbering ? context?.scope?.seasonNumber : undefined)) === undefined ? {} : { season: target.seasonNumber ?? context?.scope?.seasonNumber }),
      ...((target.episodeNumber ?? (useScopeNumbering ? context?.scope?.episodeNumber : undefined)) === undefined ? {} : { episode: target.episodeNumber ?? context?.scope?.episodeNumber }),
      ...((target.absoluteEpisodeNumber ?? (useScopeNumbering ? context?.scope?.absoluteEpisodeNumber : undefined)) === undefined ? {} : { absoluteEpisode: target.absoluteEpisodeNumber ?? context?.scope?.absoluteEpisodeNumber }),
      ...(target.title === undefined ? {} : { title: target.title }),
      ...(target.airDateUtc == null ? {} : { airDate: target.airDateUtc }),
    })),
    targetIds: (context?.targets ?? []).map(target => target.targetId),
    arrTargetIds: request.arrTargetIds ?? [],
    ...(context?.targets?.length || context?.kind !== 'movie' ? {} : {
      intents: [{
        id: `movie:${String(context.externalIds?.tmdbId ?? context.externalIds?.tmdb ?? context.titles?.[0] ?? 'request').toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-')}:${context.year ?? ''}`,
        type: 'movie',
      }],
    }),
    ...(context?.scope?.type === 'season' && !context.targets?.length ? {
      intents: [{ id: `season:${context.scope.seasonNumber ?? 'unspecified'}`, type: 'season', ...(context.scope.seasonNumber === undefined ? {} : { season: context.scope.seasonNumber }) }],
    } : {}),
    ...(context?.scope?.type === 'episode' && !context.targets?.length ? {
      intents: [{ id: `episode:${context.scope.seasonNumber ?? 'x'}:${context.scope.episodeNumber ?? 'x'}:${context.scope.absoluteEpisodeNumber ?? 'x'}`, type: 'episode', ...(context.scope.seasonNumber === undefined ? {} : { season: context.scope.seasonNumber }), ...(context.scope.episodeNumber === undefined ? {} : { episode: context.scope.episodeNumber }), ...(context.scope.absoluteEpisodeNumber === undefined ? {} : { absoluteEpisode: context.scope.absoluteEpisodeNumber }) }],
    } : {}),
    context: [
      ...(context?.relatedEpisodes ?? []).map(item => item.contextReason),
      ...(context?.overview ? [context.overview] : []),
    ],
    contextEpisodes: (context?.relatedEpisodes ?? []).map(item => ({
      id: item.episodeRef,
      ...(item.seasonNumber === undefined ? {} : { season: item.seasonNumber }),
      ...(item.episodeNumber === undefined ? {} : { episode: item.episodeNumber }),
      ...(item.absoluteEpisodeNumber === undefined ? {} : { absoluteEpisode: item.absoluteEpisodeNumber }),
      ...(item.title === undefined ? {} : { title: item.title }),
      ...(item.airDateUtc === undefined || item.airDateUtc === null ? {} : { airDate: item.airDateUtc }),
      contextReason: item.contextReason,
      hasFile: item.hasFile, queued: item.queued, monitored: item.monitored, available: item.available,
    })),
    showMetadata: {
      ...(context?.originalLanguage ? { originalLanguage: context.originalLanguage } : {}),
      ...(context?.seriesType ? { seriesType: context.seriesType } : {}),
      ...(context?.episodeTitle ? { episodeTitle: context.episodeTitle } : {}),
      ...(context?.profileContext ? { profile: context.profileContext } : {}),
    },
    preferences: request.preferences ?? {},
  });
}

export const finalizeReleaseSetInputSchema = z.object({
  status: z.enum(['matched', 'no-match', 'needs-input']),
  selections: z.array(z.object({
    candidateId: nonempty,
    targetIds: z.array(nonempty),
    reason: nonempty.max(2000),
    uncertainty: z.string().max(2000),
  }).strict()),
  gaps: z.array(nonempty),
  deferred: z.array(nonempty),
  broadCoverage: z.enum(['complete', 'partial', 'none', 'unknown']).optional(),
  scopeGaps: z.array(nonempty).optional(),
  warnings: z.array(nonempty).optional(),
  message: z.string().max(2000).optional(),
}).strict();
export const releaseSetSchema = finalizeReleaseSetInputSchema.extend({
  version: z.literal(1),
  planId: nonempty,
  coverage: z.object({
    covered: z.array(nonempty), gaps: z.array(nonempty), deferred: z.array(nonempty),
    broad: z.object({ status: z.enum(['complete', 'partial', 'none', 'unknown']), gaps: z.array(nonempty) }).strict(),
  }).strict(),
});
export type ReleaseSet = z.infer<typeof releaseSetSchema>;

export interface LedgerCandidate {
  id: string;
  physicalId: string;
  /** Eligibility/exclusion membership only; never deterministic scope evidence. */
  targets: string[];
  identityConflict?: boolean;
}
export interface FinalizationLedger {
  searchId: string;
  planId?: string;
  targets: string[];
  candidates: LedgerCandidate[];
}

/** Validate model output only against trusted, owning-search ledger facts. */
export function finalizeReleaseSet(raw: unknown, ledger: FinalizationLedger): ReleaseSet {
  if (!ledger.searchId.trim()) throw new Error('Invalid owning search');
  const input = finalizeReleaseSetInputSchema.parse(raw);
  const output = input;
  const targetSet = new Set(ledger.targets), candidates = new Map(ledger.candidates.map(c => [c.id, c]));
  if (targetSet.size !== ledger.targets.length || candidates.size !== ledger.candidates.length) throw new Error('Invalid ledger membership');
    const selectedPhysical = new Set<string>();
  const selectedTargets = new Set<string>();
  for (const selection of output.selections) {
    const candidate = candidates.get(selection.candidateId);
    if (!candidate) throw new Error('Candidate does not belong to owning search');
    if (candidate.identityConflict) throw new Error('Candidate has explicit identity conflict');
    if (selectedPhysical.has(candidate.physicalId)) throw new Error('Duplicate physical release');
    selectedPhysical.add(candidate.physicalId);
    if ((targetSet.size > 0 && !selection.targetIds.length) || new Set(selection.targetIds).size !== selection.targetIds.length) throw new Error('Invalid selected target set');
    for (const id of selection.targetIds) {
      if (!targetSet.has(id) || !candidate.targets.includes(id)) throw new Error('Foreign or unsupported target');
      selectedTargets.add(id);
    }
  }
  if (output.status === 'matched' && output.selections.length === 0) throw new Error('Matched release set requires a selection');
  if (output.status !== 'matched' && output.selections.length) throw new Error('Only matched plans may select releases');
  if (new Set(output.gaps).size !== output.gaps.length || new Set(output.deferred).size !== output.deferred.length) throw new Error('Duplicate gap/deferred target');
  const accounted = new Set(selectedTargets);
  for (const id of [...output.gaps, ...output.deferred]) {
    if (!targetSet.has(id) || selectedTargets.has(id) || accounted.has(id)) throw new Error('Invalid gap/deferred target');
    accounted.add(id);
  }
  if (targetSet.size && accounted.size !== targetSet.size) throw new Error('Every requested target must be covered, a gap, or deferred');
  if (!targetSet.size && !output.broadCoverage) throw new Error('Broad scope coverage must be explicit');
  const broadCoverage = output.broadCoverage ?? 'unknown';
  const scopeGaps = output.scopeGaps ?? [];
  if (broadCoverage === 'partial' && !scopeGaps.length && !output.gaps.length && !output.deferred.length)
    throw new Error('Partial coverage requires explicit gaps');
  if (broadCoverage === 'complete' && output.status !== 'matched') throw new Error('Complete broad coverage requires a matched release set');
  if (broadCoverage === 'none' && output.status === 'matched') throw new Error('A matched broad request cannot report no coverage');
  if (broadCoverage === 'complete' && scopeGaps.length) throw new Error('Complete broad coverage cannot contain requested-scope gaps');
  const planId = ledger.planId ?? createHash('sha256').update(ledger.searchId).digest('hex');
  return {
    ...output,
    version: 1,
    planId,
    coverage: { covered: [...selectedTargets].sort(), gaps: output.gaps, deferred: output.deferred, broad: { status: broadCoverage, gaps: scopeGaps } },
  };
}
