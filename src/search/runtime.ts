import { createHash, randomUUID } from 'node:crypto';
import { OpenRouter } from '@openrouter/sdk';
import type { LLMClient } from '../clients/llm';
import { OpenRouterLLM } from '../clients/llm';
import { ProwlarrClient } from '../clients/prowlarr';
import { SonarrClient } from '../clients/sonarr';
import { RadarrClient } from '../clients/radarr';
import { Http } from '../http';
import { ArrAutomation, showCooldownSettingKey, type AutomationPass } from './automation';
import { ArrObserver, type ArrProvider, type ArrTarget } from './arr';
import { SearchService, physicalRelease, safeReleaseObservation, safeText, SEARCH_PROMPT_VERSION, type SearchResult, type SearchServerContext, type SearchLimits } from './service';
import { SubmissionService, type SubmissionResult } from './submission';
import { openSearchStore, type SearchStore, type SearchRecord } from './store';
import { defaultSettings, migrateSettings, missingSettings, settingsSchema, type Settings } from './settings';
import { searchRequestSchema, type SearchRequest, type SubmissionRequest } from './contracts';
import type { Release } from '../types/prowlarr';
import { ApiError } from '../http';

export interface RuntimeClients {
  prowlarr?: Pick<ProwlarrClient, 'getIndexers' | 'getIndexerStatuses' | 'search' | 'getDownloadClients' | 'grab'>;
  sonarr?: Pick<SonarrClient, 'getSeries' | 'getEpisodes' | 'getQueue'> & Partial<Pick<SonarrClient, 'getQualityProfiles'>>;
  radarr?: Pick<RadarrClient, 'getMovies' | 'getQueue'> & Partial<Pick<RadarrClient, 'getQualityProfiles'>>;
}
export interface SearchRuntimeOptions {
  store?: SearchStore;
  databasePath?: string;
  llm?: LLMClient;
  now?: () => number;
  clients?: (settings: Settings) => RuntimeClients;
  initialSettings?: Settings;
}
export interface ActivityQuery { limit?: number; offset?: number; q?: string; status?: string; source?: 'manual' | 'automation'; kind?: 'tv' | 'movie' | 'other'; createdAtFrom?: string; createdAtTo?: string }
export interface ActivityItem { searchId: string; prompt: string; status: string; createdAt: string; finishedAt?: string; source: 'manual' | 'automation'; kind?: 'tv' | 'movie'; counts?: SearchResult['counts']; submission?: { outcome: string; outcomes?: SubmissionResult['outcomes'] } }
export const MAX_PROWLARR_MCP_CAPABILITY_TTL_MS = 35 * 60_000;
export interface PublicSearchStatus {
  searchId: string; status: string; createdAt: string; finishedAt?: string; prompt: string;
  options: SearchResult['options']; candidates: SearchResult['candidates']; events: SearchResult['events']; queuePosition?: number; waitingReason?: string; retryAt?: string;
  counts: SearchResult['counts']; message?: string;
}
const iso = (time: number | undefined): string | undefined => time === undefined || !Number.isFinite(new Date(time).getTime()) ? undefined : new Date(time).toISOString();
const sourceFingerprint = (provider: ArrProvider | 'prowlarr', settings: Settings): string | null => {
  const source = settings.integrations[provider];
  if (!source.url || !source.apiKey) return null;
  return createHash('sha256').update(`${provider}\0${source.url}\0${source.apiKey}`).digest('hex');
};
function parsePrompt(value: string): string {
  try { const parsed = JSON.parse(value) as { prompt?: unknown }; return typeof parsed.prompt === 'string' ? parsed.prompt : 'Search request'; }
  catch { return 'Search request'; }
}

/** Shared persisted runtime for HTTP/MCP adapters. Read projections never perform upstream calls. */
export class SearchRuntime {
  readonly store: SearchStore;
  private readonly clock: () => number;
  private readonly jobs = new Map<string, Promise<SearchResult>>();
  private closed = false;
  private closing = false;
  private closeJob?: Promise<void>;
  private passController?: AbortController;
  private pollJob?: Promise<AutomationPass>;
  private readonly maintenanceTimer: ReturnType<typeof setInterval>;
  private readonly prowlarrCapabilities = new Map<string, { searchId: string; settings: Settings; expiresAt: number; controller: AbortController }>();
  private readonly prowlarrMcpSessions = new Map<string, { token: string; close: () => Promise<void> }>();
  private readonly mcpSessionCloseJobs = new Set<Promise<void>>();
  private readonly mcpOperations = new Set<Promise<unknown>>();

  constructor(private readonly options: SearchRuntimeOptions) {
    this.clock = options.now ?? Date.now;
    this.store = options.store ?? openSearchStore(options.databasePath ?? 'data/media-scout-search.db');
    const saved = this.store.getSetting('application-settings');
    const candidate = saved ?? options.initialSettings ?? defaultSettings;
    const migrated = migrateSettings(candidate);
    const parsed = settingsSchema.parse(migrated.settings);
    if (migrated.migrated) this.store.migrateLegacySearchDeadlines(this.clock(), parsed.monitoring.searchRetryMinutes * 60_000);
    if (!saved || migrated.migrated) this.store.setSetting('application-settings', parsed);
    this.store.migrateLegacySearchWork(this.clock());
    this.maintain();
    this.maintenanceTimer = setInterval(() => { try { this.maintain(); this.dispatchQueued(); } catch { /* Request paths surface database failures safely. */ } }, 1_000);
    this.maintenanceTimer.unref();
    this.dispatchQueued();
  }

  getSettings(): Settings {
    const parsed = settingsSchema.safeParse(this.store.getSetting('application-settings'));
    if (!parsed.success) throw new Error('Saved application settings are invalid');
    return parsed.data;
  }
  /** Backend-only capability for one search worker; never exposed through an HTTP mint route. */
  createProwlarrMcpCapability(searchId: string, ttlMs = 15 * 60_000): { token: string; expiresAt: number } {
    if (this.closed || this.closing) throw new Error('runtime-closed');
    if (!searchId.trim()) throw new Error('invalid-search-scope');
    if (!this.store.getSearch(searchId)) throw new Error('search-not-found');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_PROWLARR_MCP_CAPABILITY_TTL_MS) throw new Error('invalid-capability-lifetime');
    const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''), expiresAt = this.clock() + ttlMs;
    this.prowlarrCapabilities.set(token, { searchId, settings: structuredClone(this.getSettings()), expiresAt, controller: new AbortController() });
    return { token, expiresAt };
  }
  revokeProwlarrMcpCapability(token: string): void {
    const cap = this.prowlarrCapabilities.get(token);
    if (cap) { cap.controller.abort(); this.prowlarrCapabilities.delete(token); }
    for (const [sessionId, session] of this.prowlarrMcpSessions) if (session.token === token) void this.closeProwlarrMcpSession(sessionId);
  }
  registerProwlarrMcpSession(sessionId: string, token: string, close: () => Promise<void>): boolean {
    if (!this.hasProwlarrMcpCapability(token) || this.prowlarrMcpSessions.has(sessionId)) return false;
    this.prowlarrMcpSessions.set(sessionId, { token, close });
    return true;
  }
  unregisterProwlarrMcpSession(sessionId: string): void { this.prowlarrMcpSessions.delete(sessionId); }
  hasProwlarrMcpSession(sessionId: string, token: string): boolean {
    const session = this.prowlarrMcpSessions.get(sessionId);
    return !!session && session.token === token && this.hasProwlarrMcpCapability(token);
  }
  async closeProwlarrMcpSessions(): Promise<void> {
    await Promise.allSettled([...this.prowlarrMcpSessions.keys()].map(id => this.closeProwlarrMcpSession(id)));
    while (this.mcpSessionCloseJobs.size) await Promise.allSettled([...this.mcpSessionCloseJobs]);
  }
  private closeProwlarrMcpSession(sessionId: string): Promise<void> {
    const session = this.prowlarrMcpSessions.get(sessionId);
    if (!session) return Promise.resolve();
    this.prowlarrMcpSessions.delete(sessionId);
    const job = Promise.resolve().then(session.close);
    this.mcpSessionCloseJobs.add(job);
    void job.then(() => this.mcpSessionCloseJobs.delete(job), () => this.mcpSessionCloseJobs.delete(job));
    return job;
  }
  hasProwlarrMcpCapability(token: string): boolean { return this.getProwlarrMcpCapability(token) !== null; }
  private getProwlarrMcpCapability(token: string) {
    const cap = this.prowlarrCapabilities.get(token);
    if (!cap || this.closing || this.closed || cap.expiresAt <= this.clock()) {
      if (cap) this.revokeProwlarrMcpCapability(token);
      return null;
    }
    return cap;
  }
  prowlarrIndexerDiscovery(token: string, requestSignal?: AbortSignal) {
    return this.trackMcpOperation(this.runProwlarrIndexerDiscovery(token, requestSignal));
  }
  private async runProwlarrIndexerDiscovery(token: string, requestSignal?: AbortSignal) {
    const cap = this.getProwlarrMcpCapability(token);
    if (!cap) throw new Error('unauthorized');
    if ((this.store.getProviderDeadline('prowlarr') ?? 0) > this.clock()) throw new Error('provider-cooldown');
    const client = this.clients(cap.settings).prowlarr;
    if (!client) throw new Error('prowlarr-unavailable');
    const controller = new AbortController(), abort = () => controller.abort(cap.controller.signal.reason), abortRequest = () => controller.abort(requestSignal?.reason);
    cap.controller.signal.addEventListener('abort', abort, { once: true });
    if (requestSignal?.aborted) abortRequest(); else requestSignal?.addEventListener('abort', abortRequest, { once: true });
    try {
      const [indexers, statuses] = await Promise.all([
        client.getIndexers({ signal: controller.signal, timeoutMs: 15_000 }),
        client.getIndexerStatuses({ signal: controller.signal, timeoutMs: 15_000 }),
      ]);
      if (this.getProwlarrMcpCapability(token) !== cap) throw new Error('capability-expired');
      const cooling = new Map(statuses.filter(s => s.disabledTill && Date.parse(s.disabledTill) > this.clock()).map(s => [s.indexerId, s.disabledTill]));
      return indexers.map(({ id, name, enable, supportsSearch, supportsRss, categories, capabilities }) => ({
        id, name: safeText(name, [cap.settings.integrations.prowlarr.apiKey, cap.settings.integrations.prowlarr.url]), enabled: enable,
        available: enable && supportsSearch !== false && !cooling.has(id), coolingUntil: cooling.get(id) ?? null,
        supportsSearch: supportsSearch ?? true, supportsRss: supportsRss ?? false,
        categories: (categories ?? capabilities?.categories ?? []).map(category => ({ id: category.id, name: safeText(category.name, [cap.settings.integrations.prowlarr.apiKey, cap.settings.integrations.prowlarr.url]) })),
      }));
    } catch (error) { this.recordProwlarrFailure(error); throw new Error('Prowlarr discovery failed'); }
    finally { controller.abort(); cap.controller.signal.removeEventListener('abort', abort); requestSignal?.removeEventListener('abort', abortRequest); }
  }
  prowlarrSearch(token: string, input: { query: string; indexerIds?: number[]; categories?: number[]; type?: 'search' | 'tvsearch' | 'moviesearch' | 'musicsearch' | 'booksearch'; limit?: number; offset?: number; timeoutMs?: number }, requestSignal?: AbortSignal) {
    return this.trackMcpOperation(this.runProwlarrSearch(token, input, requestSignal));
  }
  private async runProwlarrSearch(token: string, input: { query: string; indexerIds?: number[]; categories?: number[]; type?: 'search' | 'tvsearch' | 'moviesearch' | 'musicsearch' | 'booksearch'; limit?: number; offset?: number; timeoutMs?: number }, requestSignal?: AbortSignal) {
    const cap = this.getProwlarrMcpCapability(token);
    if (!cap) throw new Error('unauthorized');
    if ((this.store.getProviderDeadline('prowlarr') ?? 0) > this.clock()) throw new Error('provider-cooldown');
    const client = this.clients(cap.settings).prowlarr;
    if (!client) throw new Error('prowlarr-unavailable');
    const timeoutMs = Math.max(100, Math.min(input.timeoutMs ?? 30_000, 120_000));
    const controller = new AbortController(), abort = () => controller.abort(cap.controller.signal.reason), abortRequest = () => controller.abort(requestSignal?.reason);
    cap.controller.signal.addEventListener('abort', abort, { once: true });
    if (requestSignal?.aborted) abortRequest(); else requestSignal?.addEventListener('abort', abortRequest, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const [indexes, statuses] = await Promise.all([
        client.getIndexers({ signal: controller.signal, timeoutMs }),
        client.getIndexerStatuses({ signal: controller.signal, timeoutMs }),
      ]);
      const cooling = new Set(statuses.filter(s => s.disabledTill && Date.parse(s.disabledTill) > this.clock()).map(s => s.indexerId));
      const eligible = indexes.filter(i => i.enable && i.supportsSearch !== false && !cooling.has(i.id)).map(i => i.id);
      if (!eligible.length) throw new Error('no-healthy-indexers');
      const selected = input.indexerIds === undefined ? eligible : [...new Set(input.indexerIds.filter(id => eligible.includes(id)))];
      if (!selected.length) throw new Error('no-healthy-indexers');
      const upstreamRows = await client.search({ query: input.query, categories: input.categories ?? [], indexerIds: selected, limit: Math.min(input.limit ?? 100, 100), ...(input.offset === undefined ? {} : { offset: input.offset }), ...(input.type ? { type: input.type } : {}) }, { signal: controller.signal, timeoutMs });
      if (this.getProwlarrMcpCapability(token) !== cap) throw new Error('capability-expired');
      return this.storeCandidates(cap.searchId, upstreamRows.filter(row => selected.includes(row.indexerId)), [cap.settings.integrations.prowlarr.apiKey, cap.settings.integrations.prowlarr.url]);
    } catch (error) { this.recordProwlarrFailure(error); throw error instanceof Error && ['no-healthy-indexers','provider-cooldown','unauthorized'].includes(error.message) ? error : new Error('Prowlarr search failed'); }
    finally { controller.abort(); clearTimeout(timer); cap.controller.signal.removeEventListener('abort', abort); requestSignal?.removeEventListener('abort', abortRequest); }
  }
  private storeCandidates(searchId: string, releases: Release[], secrets: string[]) {
    const byKey = new Map<string, { candidateId: string; observations: ReturnType<typeof safeReleaseObservation>[] }>();
    for (const release of releases) {
      const key = physicalRelease(release);
      let entry = byKey.get(key);
      if (!entry) {
        const prior = this.store.listCandidates(searchId, this.clock()).find(row => (this.store.getCandidate(searchId, row.candidateId, this.clock())?.privateData as { physicalKey?: string } | undefined)?.physicalKey === key);
        entry = prior ? prior.safe as { candidateId: string; observations: ReturnType<typeof safeReleaseObservation>[] } : { candidateId: randomUUID(), observations: [] };
      }
      if (!entry) throw new Error('candidate registration failed');
      const safe = safeReleaseObservation(release, secrets, true);
      if (!entry.observations.some(o => JSON.stringify(o) === JSON.stringify(safe))) entry.observations.push(safe);
      byKey.set(key, entry);
      const record = { searchId, candidateId: entry.candidateId, safe: entry, privateData: { release, physicalKey: key }, expiresAt: this.clock() + 1_800_000 };
      if (this.store.getCandidate(searchId, entry.candidateId, this.clock())) this.store.updateCandidate(record); else this.store.addCandidate(record);
    }
    return [...byKey.values()];
  }
  private recordProwlarrFailure(error: unknown) {
    if (error instanceof ApiError && error.status === 429) this.store.setProviderDeadline('prowlarr', this.clock() + (error.retryAfter ?? 60) * 1000);
  }
  private trackMcpOperation<T>(operation: Promise<T>): Promise<T> {
    this.mcpOperations.add(operation);
    void operation.then(() => this.mcpOperations.delete(operation), () => this.mcpOperations.delete(operation));
    return operation;
  }
  missingSettings(settings = this.getSettings()): string[] { return missingSettings(settings); }
  saveSettings(value: unknown): { ok: true; settings: Settings } | { ok: false; issues: Array<{ path: PropertyKey[]; message: string; code: string }> } {
    const parsed = settingsSchema.safeParse(value);
    if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(({ path, message, code }) => ({ path, message, code })) };
    this.store.setSetting('application-settings', parsed.data);
    return { ok: true, settings: parsed.data };
  }

  startSearch(request: SearchRequest, serverContext: SearchServerContext = {}): { searchId: string; status: 'queued' } {
    if (this.closed || this.closing) throw new Error('runtime-closed');
    const settings = this.getSettings();
    const effective = settings.ai.preferences && !request.preferences ? { ...request, preferences: { notes: settings.ai.preferences } } : request;
    searchRequestSchema.parse(effective);
    const searchId = randomUUID();
    this.store.enqueueSearch({ searchId, prompt: JSON.stringify(effective), now: this.clock(), context: serverContext });
    this.dispatchQueued();
    return { searchId, status: 'queued' };
  }

  async getSearch(searchId: string): Promise<PublicSearchStatus | null> {
    this.maintain();
    const record = this.store.getSearch(searchId);
    if (!record) return null;
    const result = record.result as SearchResult | undefined;
    const candidates = result?.candidates ?? this.store.listCandidates(searchId, this.clock()).map(row => row.safe as SearchResult['candidates'][number]);
    const events = this.store.getEvents(searchId) as SearchResult['events'];
    const counts = result?.counts ?? { decisions: 0, searches: 0, candidates: candidates.length };
    const queued = record.status === 'queued';
    const settings = queued ? this.getSettings() : undefined;
    const cooldown = queued ? ['prowlarr','model'].map(provider => this.store.getProviderDeadline(provider) ?? 0).reduce((a,b)=>Math.max(a,b),0) : 0;
    const waitingReason = queued ? this.missingSettings(settings).length ? 'settings-incomplete' : cooldown > this.clock() ? 'provider-cooldown' : this.store.activeSearchCount(this.clock()) >= 3 ? 'capacity' : undefined : undefined;
    return {
      searchId, status: record.status, createdAt: new Date(record.createdAt).toISOString(),
      ...(record.finishedAt === undefined ? {} : { finishedAt: new Date(record.finishedAt).toISOString() }), prompt: safeText(parsePrompt(record.prompt)),
      options: result?.options ?? [], candidates, events, counts, ...(result?.message ? { message: result.message } : {}),
      ...(queued ? { queuePosition: this.store.queuePosition(searchId) ?? undefined, ...(waitingReason ? { waitingReason } : {}), ...(cooldown > this.clock() ? { retryAt: new Date(cooldown).toISOString() } : {}) } : {}),
    };
  }

  activity(query: ActivityQuery = {}): { items: ActivityItem[]; total: number; retention: { days: 30; maxEntries: 10000 } } {
    this.maintain();
    const limit = Math.max(1, Math.min(query.limit ?? 50, 100));
    const offset = Math.max(0, query.offset ?? 0);
    const records = this.store.listSearches(10000, false).map((record) => this.activityItem(record));
    const from = query.createdAtFrom ? Date.parse(query.createdAtFrom) : undefined, to = query.createdAtTo ? Date.parse(query.createdAtTo) : undefined;
    const matches = records.filter((item) => {
      const kind = item.kind;
      return (!query.q || item.prompt.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) && (!query.status || item.status === query.status || item.submission?.outcome === query.status) && (!query.source || item.source === query.source) && (!query.kind || (query.kind === 'other' ? !kind : kind === query.kind)) && (from === undefined || Date.parse(item.createdAt) >= from) && (to === undefined || Date.parse(item.createdAt) <= to);
    });
    return { items: matches.slice(offset, offset + limit), total: matches.length, retention: { days: 30, maxEntries: 10000 } };
  }

  async downloadClients(): Promise<Array<{ id: number; name: string; protocol: string; categories: boolean }>> {
    const client = this.clients(this.getSettings()).prowlarr;
    return client ? new SubmissionService({ prowlarr: client, store: this.store, getPolicy: () => this.submissionPolicy() , clock: this.clock }).listClients() : [];
  }

  async submit(request: SubmissionRequest, serverContext: import('./submission').SubmissionServerContext = {}): Promise<SubmissionResult> {
    const settings = this.getSettings(), clients = this.clients(settings);
    if (!clients.prowlarr) return { searchId: request.searchId, optionId: request.optionId, outcome: 'failed', candidateIds: [], outcomes: [] };
    const bound = this.store.getSetting(`search-arr:${request.searchId}`) as ArrTarget | null;
    const context = bound ? { targets: [bound.key], validate: () => this.createObserver().validateTarget(bound), fingerprint: () => this.createObserver().sourceFingerprint(bound.provider) ?? 'source-removed', available: serverContext.available } : serverContext;
    const result = await new SubmissionService({ prowlarr: clients.prowlarr, store: this.store, getPolicy: () => this.submissionPolicy(), clock: this.clock }).submit(request, this.submissionContext(context));
    this.store.appendEvent(request.searchId, { type: 'submission', data: result }, this.clock());
    return result;
  }

  /** Explicit poll; observers are refreshed even when automation is paused. */
  async poll(): Promise<AutomationPass> {
    if (this.closing || this.closed) return { observedAt: this.clock(), ran: false, reason: 'runtime-closing' };
    this.maintain();
    if (this.pollJob) return this.pollJob;
    const policy = this.getSettings();
    const observer = this.createObserver();
    const passOwner = this.store.newOwner();
    if (!this.store.acquireLease('automation-pass', passOwner, this.clock(), 15 * 60_000))
      return { observedAt: this.clock(), ran: false, reason: 'already-running' };
    const passController = new AbortController();
    this.passController = passController;
    const passHeartbeat = setInterval(() => {
      if (!this.store.renewLease('automation-pass', passOwner, this.clock(), 15 * 60_000)) passController.abort();
    }, 30_000);
    passHeartbeat.unref();
    const poll = async () => {
      if (!policy.monitoring.enabled || this.missingSettings(policy).length) { await observer.observe(); return { observedAt: this.clock(), ran: false, reason: policy.monitoring.enabled ? 'search-unavailable' : 'disabled' }; }
      const clients = this.clients(this.getSettings());
      if (!clients.prowlarr) return { observedAt: this.clock(), ran: false, reason: 'search-unavailable' };
      const automation = this.createAutomation(observer, clients.prowlarr);
      return automation.runPass(passController.signal);
    };
    this.pollJob = poll().finally(() => { clearInterval(passHeartbeat); this.store.releaseLease('automation-pass', passOwner); if (this.passController === passController) this.passController = undefined; this.pollJob = undefined; });
    return this.pollJob;
  }

  automationStatus(): { enabled: boolean; dryRun: boolean; running: boolean; providers: Array<{ provider: ArrProvider; known: boolean; observedAt: string; error?: string; unidentifiedQueueRows: number; unknownSeriesIds?: string[] }>; items: Array<{ targetId: string; title: string; kind: 'tv' | 'movie'; seriesId?: string; seasonNumber?: number; episodeNumber?: number; status: string; eligible: boolean; observedAt: string; nextAttemptAt?: string; lastAttemptAt?: string }> } {
    const settings = this.getSettings();
    const providers = (['sonarr', 'radarr'] as const).map((provider) => {
      const cached = this.store.getObservation(provider);
      const payload = cached?.payload as any;
      return { provider, known: !!cached?.complete, observedAt: iso(cached?.observedAt)!, ...(payload?.error ? { error: String(payload.error) } : {}), unidentifiedQueueRows: Number(payload?.diagnostics?.unidentifiedQueueRows ?? 0), ...(payload?.diagnostics?.unknownSeriesIds ? { unknownSeriesIds: payload.diagnostics.unknownSeriesIds.map(String) } : {}) };
    });
    const items: Array<{ targetId: string; title: string; kind: 'tv' | 'movie'; seriesId?: string; seasonNumber?: number; episodeNumber?: number; status: string; eligible: boolean; observedAt: string; nextAttemptAt?: string; lastAttemptAt?: string }> = [];
    for (const provider of ['sonarr', 'radarr'] as const) {
      const cached = this.store.getObservation(provider); const payload = cached?.payload as any;
      for (const target of (payload?.targets ?? []) as Array<Record<string, unknown>>) {
        const title = typeof target.context === 'object' && target.context !== null && typeof (target.context as any).title === 'string' ? (target.context as any).title : 'Unknown item';
        const targetId = this.targetId(target as unknown as ArrTarget);
        const context = target.context as Record<string, unknown> | undefined;
        if (!cached?.complete || target.hasFile || !target.monitored || target.available !== true) continue;
        const key = String(target.key), attempt = this.store.getAutomationAttempt(key);
        const grace = this.store.getGrace('target', key, this.clock());
        const showCooldown = provider === 'sonarr' && typeof target.serviceId === 'number' && typeof target.sourceFingerprint === 'string' ? Number(this.store.getSetting(showCooldownSettingKey(target.sourceFingerprint, target.serviceId)) ?? 0) : 0;
        const deadline = Math.max(attempt?.deadline ?? 0, this.store.getDeadline(key) ?? 0, showCooldown, this.store.getProviderDeadline(provider) ?? 0, this.store.getProviderDeadline('prowlarr') ?? 0, this.store.getProviderDeadline('model') ?? 0);
        const status = target.available && !target.eligible ? 'downloading' : grace ? 'grace' : deadline > this.clock() ? (attempt?.failCount ? 'backoff' : 'cooldown') : 'missing';
        items.push({ targetId, title: safeText(title), kind: provider === 'sonarr' ? 'tv' : 'movie', ...(target.serviceId === undefined ? {} : { seriesId: String(target.serviceId) }), ...(context?.seasonNumber === undefined ? {} : { seasonNumber: context.seasonNumber as number }), ...(context?.episodeNumber === undefined ? {} : { episodeNumber: context.episodeNumber as number }), status, eligible: !!target.eligible && !grace && deadline <= this.clock(), observedAt: iso(cached?.observedAt)!, ...(Math.max(grace ?? 0, deadline) > this.clock() ? { nextAttemptAt: iso(Math.max(grace ?? 0, deadline)) } : {}), ...(attempt ? { lastAttemptAt: iso(attempt.lastAttempt) } : {}) });
      }
    }
    return { enabled: settings.monitoring.enabled, dryRun: settings.safety.dryRun, running: !!this.pollJob || this.store.hasLiveLease('automation-pass', this.clock()), providers, items };
  }

  async drain(): Promise<void> {
    while (this.jobs.size || this.pollJob || this.mcpOperations.size || this.mcpSessionCloseJobs.size) {
      await Promise.allSettled([
        ...this.jobs.values(),
        ...(this.pollJob ? [this.pollJob.then(() => undefined)] : []),
        ...this.mcpOperations,
        ...this.mcpSessionCloseJobs,
      ]);
      if (this.jobs.size || this.pollJob || this.mcpOperations.size || this.mcpSessionCloseJobs.size) await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  async close(): Promise<void> {
    if (this.closeJob) return this.closeJob;
    if (this.closed) return;
    this.quiesce();
    this.closeJob = (async () => {
      await this.drain();
      this.closed = true; clearInterval(this.maintenanceTimer); this.store.close();
    })();
    return this.closeJob;
  }
  quiesce(): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.passController?.abort();
    for (const token of [...this.prowlarrCapabilities.keys()]) this.revokeProwlarrMcpCapability(token);
  }

  async startArrSearch(targetId: string): Promise<{ searchId: string; status: 'queued' }> {
    const snapshot = await this.createObserver().observe();
    const target = snapshot.targets.find(t => this.targetId(t) === targetId);
    if (!target || !snapshot[target.provider].known || !target.eligible) throw new Error('target-not-eligible');
    if (this.store.getGrace('target', target.key, this.clock()) || ['model', 'prowlarr', target.provider].some(p => (this.store.getProviderDeadline(p) ?? 0) > this.clock()) || this.store.hasLiveLease(`target:${target.key}`, this.clock())) throw new Error('target-held');
    const old = this.store.getAutomationAttempt(target.key);
    this.store.setDeadline(target.key, 0);
    if (old) this.store.setAutomationAttempt(target.key, { ...old, deadline: 0 });
    const context = target.context;
    const request: SearchRequest = { prompt: `Find ${String(context.title)}${target.episodeId ? ` S${context.seasonNumber}E${context.episodeNumber}` : ''}`, context: {
      kind: target.provider === 'sonarr' ? 'tv' : 'movie', titles: context.titles as string[], externalIds: context.externalIds as Record<string, string | number>,
      scope: target.episodeId ? { type: 'episode', seasonNumber: context.seasonNumber as number, episodeNumber: context.episodeNumber as number, ...(typeof context.absoluteEpisodeNumber === 'number' ? { absoluteEpisodeNumber: context.absoluteEpisodeNumber } : {}) } : { type: 'movie' },
      targets: [{ targetId: target.key }], ...(typeof context.year === 'number' ? { year: context.year } : {}),
    } };
    return this.startSearch(request, { targetKeys: [target.key], targetBindings: [target] });
  }

  private targetId(target: ArrTarget): string { return createHash('sha256').update(target.key ?? `${target.provider}:${target.serviceId}:${target.episodeId ?? target.movieId}`).digest('hex').slice(0, 24); }

  private activityItem(record: SearchRecord): ActivityItem {
    const result = record.result as SearchResult | undefined;
    const events = this.store.getEvents(record.searchId) as Array<{type:string;data?:SubmissionResult;recordedAt:number}>;
    const receipt = this.store.latestSubmission(record.searchId);
    const receiptResult = (receipt?.payload as {result?: Partial<SubmissionResult>} | undefined)?.result;
    const fallback = receipt ? { outcome: receipt.outcome === 'submitting' ? 'uncertain' : receipt.outcome, outcomes: receiptResult?.outcomes?.map(({candidateId,outcome}) => ({candidateId,outcome})) } : undefined;
    const event = events.filter(e => e.type === 'submission').at(-1);
    const submission = receipt && (!event || receipt.createdAt > event.recordedAt) ? fallback : event?.data ?? fallback;
    let kind: 'tv' | 'movie' | undefined;
    try { const parsed = JSON.parse(record.prompt).context?.kind; if (parsed === 'tv' || parsed === 'movie') kind = parsed; } catch { /* contextless request */ }
    return { searchId: record.searchId, prompt: safeText(parsePrompt(record.prompt)), status: record.status, createdAt: new Date(record.createdAt).toISOString(), ...(record.finishedAt === undefined ? {} : { finishedAt: new Date(record.finishedAt).toISOString() }), source: this.store.getSetting(`search-source:${record.searchId}`) === 'automation' ? 'automation' : 'manual', ...(kind ? { kind } : {}), ...(result?.counts ? { counts: result.counts } : {}), ...(submission ? { submission: { outcome: submission.outcome, outcomes: submission.outcomes } } : {}) };
  }
  private llm(settings: Settings): LLMClient {
    if (this.options.llm) return this.options.llm;
    return new OpenRouterLLM({ client: new OpenRouter({ apiKey: settings.ai.apiKey, serverURL: settings.ai.baseUrl, retryConfig: { strategy: 'none' } }), model: settings.ai.model });
  }
  private clients(settings: Settings): RuntimeClients {
    if (this.options.clients) return this.options.clients(settings);
    const make = (url: string, key: string) => new Http({ baseUrl: url, apiKey: key });
    return {
      ...(settings.integrations.prowlarr.url && settings.integrations.prowlarr.apiKey ? { prowlarr: new ProwlarrClient(make(settings.integrations.prowlarr.url, settings.integrations.prowlarr.apiKey)) } : {}),
      ...(settings.integrations.sonarr.url && settings.integrations.sonarr.apiKey ? { sonarr: new SonarrClient(make(settings.integrations.sonarr.url, settings.integrations.sonarr.apiKey)) } : {}),
      ...(settings.integrations.radarr.url && settings.integrations.radarr.apiKey ? { radarr: new RadarrClient(make(settings.integrations.radarr.url, settings.integrations.radarr.apiKey)) } : {}),
    };
  }
  private createObserver(): ArrObserver {
    const clients = this.clients(this.getSettings());
    return new ArrObserver({
      source: () => { const current = this.getSettings(); return { ...(sourceFingerprint('sonarr', current) ? { sonarr: { id: 'sonarr', url: current.integrations.sonarr.url, apiKey: current.integrations.sonarr.apiKey } } : {}), ...(sourceFingerprint('radarr', current) ? { radarr: { id: 'radarr', url: current.integrations.radarr.url, apiKey: current.integrations.radarr.apiKey } } : {}) }; },
      sonarr: clients.sonarr,
      radarr: clients.radarr,
      store: this.store, clock: this.clock, onRetryAfter: (provider, seconds) => this.store.setProviderDeadline(provider, this.clock() + seconds * 1000),
    });
  }
  private createAutomation(observer: ArrObserver, _prowlarr: NonNullable<RuntimeClients['prowlarr']>): ArrAutomation {
    const getPolicy = () => { const s = this.getSettings(); return { enabled: s.monitoring.enabled, dryRun: s.safety.dryRun, preferences: s.ai.preferences, queueGraceMinutes: s.monitoring.queueGraceMinutes, searchRetryMinutes: s.monitoring.searchRetryMinutes, intervalMinutes: s.monitoring.intervalMinutes, failureBackoffMinMinutes: s.monitoring.failureBackoffMinMinutes, failureBackoffMaxMinutes: s.monitoring.failureBackoffMaxMinutes }; };
    const search = { run: async (request: SearchRequest, _limits?: any, signal?: AbortSignal, context?: SearchServerContext) => {
       const targetBindings: ArrTarget[] = [];
       for (const key of context?.targetKeys ?? []) for (const provider of ['sonarr', 'radarr'] as const) {
          const observation = this.store.getObservation(provider)?.payload as { targets?: ArrTarget[] } | undefined;
          const target = observation?.targets?.find(item => item.key === key);
          if (target) targetBindings.push(target);
        }
         const searchId = randomUUID(), owner = this.store.newOwner(), executionContext = { ...context, targetBindings };
         const work = this.store.startAutomationSearch({ searchId, prompt: JSON.stringify(request), owner, now: this.clock(), ttl: 900_000, maxActive: 3, context: executionContext });
         if (!work) throw new Error('automation-capacity-deferred');
         return this.executeWork(work, _limits ?? {}, signal);
     } };
    const submission = { submit: async (request: SubmissionRequest, context?: any) => this.submit(request, context) };
    return new ArrAutomation({ store: this.store, observer: { observe: () => observer.observe(), validateTarget: (target: ArrTarget) => this.createObserver().validateTarget(target), sourceFingerprint: (provider) => this.createObserver().sourceFingerprint(provider) }, search, submission, getPolicy, clock: this.clock });
  }
  private submissionPolicy() { const s = this.getSettings(); return { dryRun: s.safety.dryRun, enabled: true, tvClient: s.integrations.prowlarr.tvClient, movieClient: s.integrations.prowlarr.movieClient, queueGraceMinutes: s.monitoring.queueGraceMinutes, configurationFingerprint: sourceFingerprint('prowlarr', s) ?? 'unconfigured' }; }
  private submissionContext(bound: import('./submission').SubmissionServerContext = {}) {
    return {
      ...bound,
      available: () => !!sourceFingerprint('prowlarr', this.getSettings()) && !this.getSettings().safety.dryRun && (bound.available?.() ?? true),
      fingerprint: () => `${sourceFingerprint('prowlarr', this.getSettings()) ?? 'unconfigured'}:${bound.fingerprint?.() ?? ''}`,
    };
  }
  private maintain(): void {
    for (const [token, capability] of this.prowlarrCapabilities) if (capability.expiresAt <= this.clock()) this.revokeProwlarrMcpCapability(token);
    this.store.recoverExpiredSearchWork(this.clock());
    for (const search of this.store.activeSearches()) {
      if (search.status === 'queued') continue;
      const workOwner = this.store.searchWorkOwner(search.searchId);
      if (workOwner !== null) continue;
      const owner = this.store.getSetting(`search-owner:${search.searchId}`);
      if (typeof owner === 'string' && !this.store.ownsLease(`search:${search.searchId}`, owner, this.clock())) this.store.interruptSearch(search.searchId, this.clock());
    }
    this.store.maintain(this.clock());
  }
  private dispatching = false;
  private dispatchQueued(): void {
    if (this.closed || this.closing || this.dispatching || this.missingSettings().length) return;
    if (['prowlarr','model'].some(provider => (this.store.getProviderDeadline(provider) ?? 0) > this.clock())) return;
    this.dispatching = true;
    try {
      const settings = this.getSettings(), clients = this.clients(settings);
      if (!clients.prowlarr) return;
      for (;;) {
        const owner = this.store.newOwner();
        const work = this.store.claimNextSearch(owner, this.clock(), 900_000, 3);
        if (!work) break;
        void this.executeWork(work).catch(() => undefined);
      }
    } finally { this.dispatching = false; }
  }
  private executeWork(work: import('./store').SearchWork, limits: SearchLimits = {}, signal?: AbortSignal): Promise<SearchResult> {
    let completion: Promise<SearchResult>;
    try {
      const settings = this.getSettings(), prowlarr = this.clients(settings).prowlarr;
      if (!prowlarr) throw new Error('prowlarr-unavailable');
      const request = JSON.parse(work.prompt) as SearchRequest;
      const service = new SearchService({ llm: this.llm(settings), prowlarr, store: this.store, clock: this.clock, limits: { decisions: settings.search.maxDecisions, searches: settings.search.maxSearches, deadlineMs: settings.search.deadlineMinutes * 60_000 } });
      completion = service.run(request, limits, signal, work.context as SearchServerContext, work.searchId, work.owner);
    } catch (error) {
      const message = error instanceof Error ? safeText(error.message) : 'Search could not start';
      const result: SearchResult = { searchId: work.searchId, status: 'failed', message, options: [], candidates: [], counts: { decisions: 0, searches: 0, candidates: 0 }, events: [{ type: 'error', data: { code: 'worker-start-failed' } }], promptVersion: SEARCH_PROMPT_VERSION };
      this.store.finishOwnedSearch(work.searchId, work.owner, 'failed', result, this.clock());
      return Promise.resolve(result);
    }
    this.jobs.set(work.searchId, completion);
    void completion.catch(() => undefined).finally(() => { this.jobs.delete(work.searchId); });
    return completion;
  }
}

export { defaultSettings, missingSettings, settingsSchema } from './settings';
