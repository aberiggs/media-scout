import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LLMClient } from '../clients/llm';
import type { ProwlarrClient } from '../clients/prowlarr';
import type { Release } from '../types/prowlarr';
import { ApiError } from '../http';
import { parseReleaseCoverage } from '../core/parser';
import { EPISODE_SET_LIMITS, SEARCH_PROMPT_CONTRACT, episodeSetActionSchema, searchActionSchema, searchRequestSchema, type SearchRequest, type SearchStatus, type RankedOption, type EpisodeSetOption } from './contracts';
import { validateRankedOptions } from './selection';
import type { SearchStore } from './store';

export interface SearchLimits { decisions?: number; searches?: number; deadlineMs?: number }
export interface SearchEvent { type: string; data: unknown }
export interface CandidateObservation {
  title: string; indexer: string; size: number | null; seeders: number | null;
  leechers: number | null; grabs: number | null; age: number; protocol: string;
  tvdbId: number | null; tmdbId: number | null; indexerFlags: string[];
  scope: ReturnType<typeof parseReleaseCoverage>;
}
export interface PublicCandidate { candidateId: string; observations: CandidateObservation[]; excluded?: boolean; excludedTargetIds?: string[] }
export interface SearchServerContext { targetKeys?: string[]; targetBindings?: unknown[]; targetRefs?: Array<{ targetId: string; key: string }> }
export interface SearchResult {
  searchId: string; status: SearchStatus; message?: string; options: Array<RankedOption | EpisodeSetOption>;
  candidates: PublicCandidate[]; counts: { decisions: number; searches: number; candidates: number };
  events: SearchEvent[]; promptVersion: string;
}
export const SEARCH_PROMPT_VERSION = 'search-first-1';
export const EPISODE_SET_PROMPT_VERSION = 'episode-set-1';

/** Sanitize display/model text; private locators remain only in candidate storage. */
export function safeText(value: string): string {
  return value.replace(/(?:https?:\/\/|magnet:\?)[^\s"<>]+/giu, '[private link]')
    .replace(/\b[\da-f]{32,64}\b/giu, '[private identifier]').replace(/[\u0000-\u001f\u007f]/gu, ' ');
}
export function physicalRelease(release: Pick<Release, 'infoHash' | 'indexerId' | 'guid'>): string {
  return createHash('sha256').update(release.infoHash?.toLowerCase() || `${release.indexerId}:${release.guid}`).digest('hex');
}
function observation(r: Release): CandidateObservation {
  return { title: safeText(r.title), indexer: safeText(r.indexer), size: r.size, seeders: r.seeders,
    leechers: r.leechers, grabs: r.grabs, age: r.age, protocol: r.protocol, tvdbId: r.tvdbId,
    tmdbId: r.tmdbId, indexerFlags: r.indexerFlags.map(safeText), scope: parseReleaseCoverage(r.title) };
}
const { $schema: _meta, ...actionSchema } = z.toJSONSchema(searchActionSchema);
const { $schema: _batchMeta, ...episodeSetActionJsonSchema } = z.toJSONSchema(episodeSetActionSchema);
const SYSTEM = `${SEARCH_PROMPT_CONTRACT}
You have read-only list_indexers and search_releases tools. Use several turns to try useful alternate titles, seasonal and supplied absolute numbering; do not invent numbering. For an episode request, also try suitable season-pack queries and prefer a quality/health-compatible pack that demonstrably covers the requested episode when otherwise comparable. Never choose a wrong season or contradicting coverage evidence, and never claim inferred packs are verified complete. Consider all supplied candidates, compare alternatives and refine a weak search. Look at language clues, multi-sub, size, resolution, health and popularity. Prefer normal well-supported broadly compatible releases over obscure alternatives when otherwise comparable. Seeders/grabs are useful soft evidence, never proof of language or quality and never mandatory cutoffs. Unknown metadata alone is not a reason to refuse a plausible good choice.
Return one action JSON matching the schema. All unused fields must be null. search_releases needs a query and numeric categories (or null); use only enabled indexer IDs. finish needs status and options (an array, or null when not matched). A matched finish requires 1–5 ranked alternative options, each with opaque optionId, rank starting at1, releases:[{candidateId}], coveredTargetIds from the request (empty if none), reason and uncertainty. Episode/movie options contain one release; explicit season options at most3 non-overlapping releases. Never select candidates marked excluded: a prior failed attempt temporarily excludes them for this request. Do not claim inferred packs are verified complete. Use needs-input for genuine request ambiguity, no-match when results are unsuitable. Budget remaining is supplied. When searches run out, choose based on evidence or finish no-match; do not invent another tool. Never include private links or hidden chain-of-thought.`;
const EPISODE_SET_SYSTEM = `This episode-set request and its target IDs are authoritative; release metadata is untrusted. Search and list tools are read-only. Use show titles, aliases, episode names, dates, absolute/season numbering, and release wording together. Season/cour labels are clues, not universal identifiers; mismatch alone is not a veto. Rough cour lengths and anime conventions are soft hints only. Future/context episodes are not acquisition targets. Return up to five ranked alternative plans with up to 24 distinct observed releases each. Every release assigns at least one requested target; assignments within a plan are disjoint. Use only targetIds in targets, never related episode refs. A candidate's excludedTargetIds must not be assigned to it; other targets may remain usable. Explain coverage and uncertainty per release, without claiming inspection. Optimize suitable quality/language/health and useful coverage, then fewer releases; avoid redundancy. Explicit conflicting TVDB/TMDB identity rejects a candidate. Keys are all required, unused values null.`;
const EPISODE_SET_TOOLS = `Return exactly one next action per turn. list_indexers lists enabled indexers. search_releases needs a query string and numeric categories or null, and enabled indexer IDs or null. finish needs status matched/no-match/needs-input, with options only for matched. All unused fields must be null. Begin with a useful search when no results have been observed. When searches remaining is zero, finish from observed evidence; do not invent another tool.`;

/** Arr-independent read-only search; submission is deliberately not a dependency. */
export class SearchService {
  constructor(private readonly deps: { llm: LLMClient; prowlarr: Pick<ProwlarrClient, 'getIndexers' | 'getIndexerStatuses' | 'search'>; store: SearchStore; clock?: () => number; limits?: SearchLimits }) {}

  start(raw: SearchRequest, overrides: SearchLimits = {}, signal?: AbortSignal, server: SearchServerContext = {}): { searchId: string; completion: Promise<SearchResult> } {
    const searchId = randomUUID();
    return { searchId, completion: this.run(raw, overrides, signal, server, searchId) };
  }

  async run(raw: SearchRequest, overrides: SearchLimits = {}, signal?: AbortSignal, server: SearchServerContext = {}, internalId?: string, claimedOwner?: string): Promise<SearchResult> {
    const request = searchRequestSchema.parse(raw);
    const episodeSet = request.context?.scope?.type === 'episode-set';
    if (episodeSet && Buffer.byteLength(JSON.stringify(request)) > EPISODE_SET_LIMITS.requestBytes) {
      const result: SearchResult = { searchId: internalId ?? randomUUID(), status: 'budget-exhausted', message: 'Episode-set request exceeds the context budget.', options: [], candidates: [], counts: { decisions: 0, searches: 0, candidates: 0 }, events: [], promptVersion: EPISODE_SET_PROMPT_VERSION };
      if (!claimedOwner) { this.deps.store.createSearch({ searchId: result.searchId, prompt: JSON.stringify(request), status: result.status, createdAt: (this.deps.clock ?? Date.now)() }); this.deps.store.finishSearch(result.searchId, result.status, result, (this.deps.clock ?? Date.now)()); }
      else this.deps.store.finishOwnedSearch(result.searchId, claimedOwner, result.status, result, (this.deps.clock ?? Date.now)());
      return result;
    }
    const id = internalId ?? randomUUID(), owner = randomUUID(), now = this.deps.clock ?? Date.now;
    const cap = (key: keyof SearchLimits, fallback: number) => Math.max(1, Math.min(overrides[key] ?? fallback, this.deps.limits?.[key] ?? fallback));
    const limits = { decisions: cap('decisions', 20), searches: cap('searches', 12), deadlineMs: cap('deadlineMs', 600_000) };
    const started = now();
    if (!claimedOwner) this.deps.store.createSearch({ searchId: id, prompt: JSON.stringify(request), status: 'running', createdAt: started });
    const events: SearchEvent[] = [], candidates = new Map<string, PublicCandidate>(), refs = new Map<string, string>();
    let decisions = 0, searches = 0, status: SearchStatus = 'failed', message: string | undefined, options: Array<RankedOption | EpisodeSetOption> = [];
    let selectionCorrections = 0;
    const record = (type: string, data: unknown) => {
      if (claimedOwner && !this.deps.store.ownsSearch(id, claimedOwner, now())) return;
      const event = { type, data }; this.deps.store.appendEvent(id, event, now()); events.push(event);
    };
    const remaining = () => limits.deadlineMs - (now() - started);
    const wait = <T>(operation: Promise<T>) => bounded(operation, remaining(), signal);
    let owned = false;
    const checkCooldown = (provider: 'prowlarr' | 'model') => {
      if ((this.deps.store.getProviderDeadline(provider) ?? 0) > now()) throw new Error('source-throttled');
    };
    try {
      if (signal?.aborted) throw new SearchInterrupted();
      checkCooldown('prowlarr'); checkCooldown('model');
      owned = claimedOwner ? this.deps.store.ownsSearch(id, claimedOwner, now()) : this.deps.store.acquireLease(`search:${id}`, owner, now(), 900_000);
      if (!owned) throw new Error('search-busy');
      if (!claimedOwner) this.deps.store.setSetting(`search-owner:${id}`, owner);
      const initialization = async () => {
        try {
          checkCooldown('prowlarr');
          const indexers = await wait(this.deps.prowlarr.getIndexers());
          checkCooldown('prowlarr');
          const states = await wait(this.deps.prowlarr.getIndexerStatuses());
          return { indexers, states };
        }
        catch (error) {
          if (error instanceof ApiError && error.retryAfter !== undefined) this.deps.store.setProviderDeadline('prowlarr', now() + error.retryAfter * 1000);
          throw error;
        }
      };
      const { indexers, states } = await initialization();
      const cooling = new Set(states.filter(s => s.disabledTill && Date.parse(s.disabledTill) > now()).map(s => s.indexerId));
      const enabled = indexers.filter(i => i.enable && !cooling.has(i.id)).map(i => ({ id: i.id, name: safeText(i.name) }));
      if (!enabled.length) throw new Error('no-healthy-indexers');
      while (decisions < limits.decisions) {
        if (remaining() <= 0) throw new SearchDeadline();
        if (!(claimedOwner ? this.deps.store.ownsSearch(id, claimedOwner, now()) : this.deps.store.ownsLease(`search:${id}`, owner, now()))) throw new SearchInterrupted();
        decisions++;
        let next: unknown;
        try {
          const modelController = new AbortController();
          const abortModel = () => modelController.abort(signal?.reason);
          if (signal?.aborted) abortModel(); else signal?.addEventListener('abort', abortModel, { once: true });
          const timer = setTimeout(() => modelController.abort(new SearchDeadline()), Math.max(0, remaining()));
          try {
            checkCooldown('model');
            const actionSchemaForRequest = episodeSet ? episodeSetActionSchema : searchActionSchema;
            const publicCandidates = [...candidates.values()];
            const evidenceBytes = Buffer.byteLength(JSON.stringify(publicCandidates));
            if (episodeSet && evidenceBytes > EPISODE_SET_LIMITS.evidenceBytes) throw new SearchContextBudget();
            const userPayload = JSON.stringify({ request, enabledIndexers: enabled, transcript: events, candidates: publicCandidates, remaining: { decisions: limits.decisions - decisions, searches: limits.searches - searches } });
            if (episodeSet && Buffer.byteLength(userPayload) > EPISODE_SET_LIMITS.inputBytes) throw new SearchContextBudget();
            next = await wait(this.deps.llm.json({ system: episodeSet ? `${EPISODE_SET_SYSTEM}\n${EPISODE_SET_TOOLS}` : SYSTEM, user: userPayload, schema: actionSchemaForRequest as typeof searchActionSchema, label: 'search-next-action', jsonSchema: { name: episodeSet ? 'episode_set_action' : 'search_action', schema: episodeSet ? episodeSetActionJsonSchema : actionSchema }, signal: modelController.signal, maxAttempts: 1, retryTransport: false }));
          } finally { clearTimeout(timer); signal?.removeEventListener('abort', abortModel); }
        } catch (error) {
          if (error instanceof ApiError && error.retryAfter !== undefined) this.deps.store.setProviderDeadline('model', now() + error.retryAfter * 1000);
          throw error;
        }
        const action = (episodeSet ? episodeSetActionSchema : searchActionSchema).parse(next);
        if (remaining() <= 0) throw new SearchDeadline();
        if (!(claimedOwner ? this.deps.store.ownsSearch(id, claimedOwner, now()) : this.deps.store.ownsLease(`search:${id}`, owner, now()))) throw new SearchInterrupted();
        if (action.action === 'list_indexers') { record('indexers', { items: enabled }); continue; }
        if (action.action === 'search_releases') {
          if (searches >= limits.searches) { status = 'budget-exhausted'; message = 'Search-call budget exhausted'; break; }
          const ids = (action.indexerIds ?? enabled.map(i => i.id)).filter(id => enabled.some(i => i.id === id));
          if (!ids.length) throw new Error('no-healthy-indexers');
          searches++;
          record('query-start', { query: safeText(action.query!), indexerIds: ids });
          let releases: Release[];
          const searchController = new AbortController();
          const abortSearch = () => searchController.abort(signal?.reason);
          if (signal?.aborted) abortSearch(); else signal?.addEventListener('abort', abortSearch, { once: true });
          const searchTimer = setTimeout(() => searchController.abort(new SearchDeadline()), Math.max(0, remaining()));
          try {
            checkCooldown('prowlarr');
            releases = await wait(this.deps.prowlarr.search(
              { query: action.query!, categories: action.categories ?? [], indexerIds: ids },
              { timeoutMs: Math.min(120_000, Math.max(1, remaining())), signal: searchController.signal },
            ));
          }
          catch (error) {
            if (error instanceof ApiError && error.retryAfter !== undefined) this.deps.store.setProviderDeadline('prowlarr', now() + error.retryAfter * 1000);
            if (searchController.signal.reason instanceof SearchDeadline) throw new SearchDeadline();
            if (signal?.aborted) throw new SearchInterrupted();
            if (error instanceof ApiError && error.timedOut) throw new ProwlarrSearchTimeout();
            if (error instanceof ApiError && error.status === 0) throw new ProwlarrSearchNetworkFailure();
            throw error;
          } finally { clearTimeout(searchTimer); signal?.removeEventListener('abort', abortSearch); }
          // All rows reach the model. Repeated physical observations retain their separate evidence.
          if (remaining() <= 0) throw new SearchDeadline();
          if (!(claimedOwner ? this.deps.store.ownsSearch(id, claimedOwner, now()) : this.deps.store.ownsLease(`search:${id}`, owner, now()))) throw new SearchInterrupted();
          for (const release of releases) {
            const key = physicalRelease(release);
            const candidateId = refs.get(key) ?? randomUUID();
            refs.set(key, candidateId);
            const candidate = candidates.get(candidateId) ?? { candidateId, observations: [] };
            candidate.observations.push(observation(release));
             candidate.excluded = server.targetKeys?.some(target => this.deps.store.isExcluded(target, key, now())) ?? false;
             if (episodeSet && server.targetRefs) candidate.excludedTargetIds = server.targetRefs.filter(ref => this.deps.store.isExcluded(ref.key, key, now())).map(ref => ref.targetId);
            candidates.set(candidateId, candidate);
            const privateData = { release, physicalKey: key };
            const entry = { searchId: id, candidateId, safe: candidate, privateData, expiresAt: now() + 1_800_000 };
            if (this.deps.store.getCandidate(id, candidateId, now())) this.deps.store.updateCandidate(entry);
            else this.deps.store.addCandidate(entry);
          }
          record('query-result', { query: safeText(action.query!), count: releases.length });
          continue;
        }
        status = action.status!;
        message = action.message ? safeText(action.message) : undefined;
        if (status === 'matched') {
          const validation = validateRankedOptions(action.options ?? [], new Set(candidates.keys()), new Set(request.context?.targets?.map(t => t.targetId) ?? []), {
             ...request.context?.scope, type: request.context?.scope?.type ?? 'unspecified',
             candidateScopes: Object.fromEntries([...candidates].map(([key, value]) => [key, value.observations.map(o => o.scope)])),
             expectedIds: request.context?.externalIds, candidateIds: Object.fromEntries([...candidates].map(([key, value]) => [key, value.observations.map(o => ({ tvdb: o.tvdbId, tmdb: o.tmdbId }))])),
           });
          if (!validation.valid) {
            record('selection-rejected', { code: validation.error });
            if (selectionCorrections++ === 0 && decisions < limits.decisions) { status = 'failed'; continue; }
            throw new Error('invalid-selection');
          }
          if (validation.options.some(o => o.releases.some(r => episodeSet
            ? (r as EpisodeSetOption['releases'][number]).coveredTargetIds.some(id => candidates.get(r.candidateId)?.excludedTargetIds?.includes(id))
            : candidates.get(r.candidateId)?.excluded))) {
            record('selection-rejected', { code: 'temporarily-excluded-release' });
            if (selectionCorrections++ === 0 && decisions < limits.decisions) { status = 'failed'; continue; }
            throw new Error('excluded-selection');
          }
          options = validation.options.map(o => ({ ...o, reason: safeText(o.reason), uncertainty: safeText(o.uncertainty),
            ...(episodeSet ? { releases: (o as EpisodeSetOption).releases.map(r => ({ ...r, coverageReason: safeText(r.coverageReason), uncertainty: safeText(r.uncertainty) })) } : {}) }));
        }
        record('finish', { status, message });
        break;
      }
      if (!events.some(e => e.type === 'finish') && status === 'failed') { status = 'budget-exhausted'; message = 'Model decision budget exhausted'; }
    } catch (error) {
      status = error instanceof SearchDeadline || error instanceof SearchContextBudget ? 'budget-exhausted' : error instanceof SearchInterrupted ? 'interrupted' : 'failed';
      const knownReason = error instanceof Error && ['search-busy', 'source-throttled', 'no-healthy-indexers'].includes(error.message) ? error.message : undefined;
      message = error instanceof ProwlarrSearchTimeout ? 'Prowlarr search timed out. Check indexer responsiveness and retry.' : error instanceof ProwlarrSearchNetworkFailure ? 'Prowlarr search network failure. Check Prowlarr availability and retry.' : error instanceof ApiError ? `Upstream HTTP ${error.status}` : error instanceof SearchDeadline ? 'Search deadline exceeded' : error instanceof SearchInterrupted ? 'Search interrupted' :
        knownReason === 'search-busy' ? 'Another search is already running. Please retry after it finishes.' :
        knownReason === 'source-throttled' ? 'A provider is temporarily throttled. Retry after its cooldown.' :
        knownReason === 'no-healthy-indexers' ? 'No enabled, available indexers can be searched right now.' :
        error instanceof SearchContextBudget ? 'Episode-set candidate evidence exceeds the model input budget.' : 'Search unavailable or invalid model output';
      record('error', { code: knownReason ?? status, ...(error instanceof ApiError ? { httpStatus: error.status, retryAfter: error.retryAfter } : {}) });
      options = [];
    } finally { if (owned && !claimedOwner) this.deps.store.releaseLease(`search:${id}`, owner); }
    const result: SearchResult = { searchId: id, status, ...(message ? { message } : {}), options, candidates: [...candidates.values()], counts: { decisions, searches, candidates: candidates.size }, events, promptVersion: episodeSet ? EPISODE_SET_PROMPT_VERSION : SEARCH_PROMPT_VERSION };
    this.deps.store.expireCandidatesAt(id, now() + 1_800_000);
    if (claimedOwner) this.deps.store.finishOwnedSearch(id, claimedOwner, status, result, now());
    else this.deps.store.finishSearch(id, status, result, now());
    return result;
  }
}
class SearchDeadline extends Error {}
class SearchInterrupted extends Error {}
class SearchContextBudget extends Error {}
class ProwlarrSearchTimeout extends Error {}
class ProwlarrSearchNetworkFailure extends Error {}
function bounded<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => { clearTimeout(timer); reject(new SearchInterrupted()); };
    if (signal?.aborted) { reject(new SearchInterrupted()); return; }
    timer = setTimeout(() => { signal?.removeEventListener('abort', abort); reject(new SearchDeadline()); }, Math.max(0, ms));
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
  });
}
