import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LLMClient } from '../clients/llm';
import type { ProwlarrClient } from '../clients/prowlarr';
import type { Release } from '../types/prowlarr';
import { ApiError } from '../http';
import { parseReleaseCoverage } from '../core/parser';
import { SEARCH_PROMPT_CONTRACT, searchActionSchema, searchRequestSchema, type SearchRequest, type SearchStatus, type RankedOption } from './contracts';
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
export interface PublicCandidate { candidateId: string; observations: CandidateObservation[]; excluded?: boolean }
export interface SearchServerContext { targetKeys?: string[]; targetBindings?: unknown[] }
export interface SearchResult {
  searchId: string; status: SearchStatus; message?: string; options: RankedOption[];
  candidates: PublicCandidate[]; counts: { decisions: number; searches: number; candidates: number };
  events: SearchEvent[]; promptVersion: string;
}
export const SEARCH_PROMPT_VERSION = 'search-first-1';

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
const SYSTEM = `${SEARCH_PROMPT_CONTRACT}
You have read-only list_indexers and search_releases tools. Use several turns to try useful alternate titles, seasonal and supplied absolute numbering; do not invent numbering. Consider all supplied candidates, compare alternatives and refine a weak search. Look at language clues, multi-sub, size, resolution, health and popularity. Prefer normal well-supported broadly compatible releases over obscure alternatives when otherwise comparable. Seeders/grabs are useful soft evidence, never proof of language or quality and never mandatory cutoffs. Unknown metadata alone is not a reason to refuse a plausible good choice.
Return one action JSON matching the schema. All unused fields must be null. search_releases needs a query and numeric categories (or null); use only enabled indexer IDs. finish needs status and options (an array, or null when not matched). A matched finish requires 1–5 ranked alternative options, each with opaque optionId, rank starting at1, releases:[{candidateId}], coveredTargetIds from the request (empty if none), reason and uncertainty. Episode/movie options contain one release; explicit season options at most3 non-overlapping releases. Never select candidates marked excluded: a prior failed attempt temporarily excludes them for this request. Do not claim inferred packs are verified complete. Use needs-input for genuine request ambiguity, no-match when results are unsuitable. Budget remaining is supplied. When searches run out, choose based on evidence or finish no-match; do not invent another tool. Never include private links or hidden chain-of-thought.`;

/** Arr-independent read-only search; submission is deliberately not a dependency. */
export class SearchService {
  constructor(private readonly deps: { llm: LLMClient; prowlarr: Pick<ProwlarrClient, 'getIndexers' | 'getIndexerStatuses' | 'search'>; store: SearchStore; clock?: () => number; limits?: SearchLimits }) {}

  start(raw: SearchRequest, overrides: SearchLimits = {}, signal?: AbortSignal, server: SearchServerContext = {}): { searchId: string; completion: Promise<SearchResult> } {
    const searchId = randomUUID();
    return { searchId, completion: this.run(raw, overrides, signal, server, searchId) };
  }

  async run(raw: SearchRequest, overrides: SearchLimits = {}, signal?: AbortSignal, server: SearchServerContext = {}, internalId?: string, claimedOwner?: string): Promise<SearchResult> {
    const request = searchRequestSchema.parse(raw);
    const id = internalId ?? randomUUID(), owner = randomUUID(), now = this.deps.clock ?? Date.now;
    const cap = (key: keyof SearchLimits, fallback: number) => Math.max(1, Math.min(overrides[key] ?? fallback, this.deps.limits?.[key] ?? fallback));
    const limits = { decisions: cap('decisions', 20), searches: cap('searches', 12), deadlineMs: cap('deadlineMs', 600_000) };
    const started = now();
    if (!claimedOwner) this.deps.store.createSearch({ searchId: id, prompt: JSON.stringify(request), status: 'running', createdAt: started });
    const events: SearchEvent[] = [], candidates = new Map<string, PublicCandidate>(), refs = new Map<string, string>();
    let decisions = 0, searches = 0, status: SearchStatus = 'failed', message: string | undefined, options: RankedOption[] = [];
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
            next = await wait(this.deps.llm.json({ system: SYSTEM, user: JSON.stringify({ request, enabledIndexers: enabled, transcript: events, candidates: [...candidates.values()], remaining: { decisions: limits.decisions - decisions, searches: limits.searches - searches } }), schema: searchActionSchema, label: 'search-next-action', jsonSchema: { name: 'search_action', schema: actionSchema }, signal: modelController.signal, maxAttempts: 1, retryTransport: false }));
          } finally { clearTimeout(timer); signal?.removeEventListener('abort', abortModel); }
        } catch (error) {
          if (error instanceof ApiError && error.retryAfter !== undefined) this.deps.store.setProviderDeadline('model', now() + error.retryAfter * 1000);
          throw error;
        }
        const action = searchActionSchema.parse(next);
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
          try { checkCooldown('prowlarr'); releases = await wait(this.deps.prowlarr.search({ query: action.query!, categories: action.categories ?? [], indexerIds: ids })); }
          catch (error) {
            if (error instanceof ApiError && error.retryAfter !== undefined) this.deps.store.setProviderDeadline('prowlarr', now() + error.retryAfter * 1000);
            throw error;
          }
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
          });
          if (!validation.valid) {
            record('selection-rejected', { code: validation.error });
            if (selectionCorrections++ === 0 && decisions < limits.decisions) { status = 'failed'; continue; }
            throw new Error('invalid-selection');
          }
          if (validation.options.some(o => o.releases.some(r => candidates.get(r.candidateId)?.excluded))) {
            record('selection-rejected', { code: 'temporarily-excluded-release' });
            if (selectionCorrections++ === 0 && decisions < limits.decisions) { status = 'failed'; continue; }
            throw new Error('excluded-selection');
          }
          options = validation.options.map(o => ({ ...o, reason: safeText(o.reason), uncertainty: safeText(o.uncertainty) }));
        }
        record('finish', { status, message });
        break;
      }
      if (!events.some(e => e.type === 'finish') && status === 'failed') { status = 'budget-exhausted'; message = 'Model decision budget exhausted'; }
    } catch (error) {
      status = error instanceof SearchDeadline ? 'budget-exhausted' : error instanceof SearchInterrupted ? 'interrupted' : 'failed';
      const knownReason = error instanceof Error && ['search-busy', 'source-throttled', 'no-healthy-indexers'].includes(error.message) ? error.message : undefined;
      message = error instanceof ApiError ? `Upstream HTTP ${error.status}` : error instanceof SearchDeadline ? 'Search deadline exceeded' : error instanceof SearchInterrupted ? 'Search interrupted' :
        knownReason === 'search-busy' ? 'Another search is already running. Please retry after it finishes.' :
        knownReason === 'source-throttled' ? 'A provider is temporarily throttled. Retry after its cooldown.' :
        knownReason === 'no-healthy-indexers' ? 'No enabled, available indexers can be searched right now.' :
        'Search unavailable or invalid model output';
      record('error', { code: knownReason ?? status, ...(error instanceof ApiError ? { httpStatus: error.status, retryAfter: error.retryAfter } : {}) });
      options = [];
    } finally { if (owned && !claimedOwner) this.deps.store.releaseLease(`search:${id}`, owner); }
    const result: SearchResult = { searchId: id, status, ...(message ? { message } : {}), options, candidates: [...candidates.values()], counts: { decisions, searches, candidates: candidates.size }, events, promptVersion: SEARCH_PROMPT_VERSION };
    this.deps.store.expireCandidatesAt(id, now() + 1_800_000);
    if (claimedOwner) this.deps.store.finishOwnedSearch(id, claimedOwner, status, result, now());
    else this.deps.store.finishSearch(id, status, result, now());
    return result;
  }
}
class SearchDeadline extends Error {}
class SearchInterrupted extends Error {}
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
