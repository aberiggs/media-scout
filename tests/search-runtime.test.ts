import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSearchStore } from '../src/search/store';
import { SearchRuntime, type RuntimeClients } from '../src/search/runtime';
import { defaultSettings, type Settings } from '../src/search/settings';
import type { LLMClient } from '../src/clients/llm';
import { releaseSchema } from '../src/types/prowlarr';

const stores: ReturnType<typeof openSearchStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = openSearchStore(':memory:'); stores.push(store);
  const settings = { version: 2, integrations: { prowlarr: { url: 'http://localhost:9696', apiKey: 'private', tvClient: '', movieClient: '' }, sonarr: { url: '', apiKey: '' }, radarr: { url: '', apiKey: '' } }, ai: { apiKey: 'private-ai', model: 'test/model', baseUrl: 'https://example.test/v1', preferences: '' }, monitoring: { enabled: false, intervalMinutes: 5, minRetryHours: 6, failureBackoffMinMinutes: 5, failureBackoffMaxMinutes: 60, queueGraceMinutes: 30 }, search: { maxDecisions: 20, maxSearches: 12, deadlineMinutes: 10 }, safety: { dryRun: true } } satisfies Settings;
  const llm = { json: async () => ({ action: 'finish', query: null, categories: null, indexerIds: null, status: 'no-match', options: null, message: 'Nothing suitable' }) } as unknown as LLMClient;
  let indexerReads = 0;
  let now = 1_800_000_000_000;
  const runtime = new SearchRuntime({ store, now: () => now, clients: () => ({ prowlarr: { getIndexers: async () => { indexerReads++; return [{ id: 1, name: 'Test', enable: true }]; }, getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [{ id: 7, name: 'TV', enable: true, protocol: 'torrent', supportsCategories: false, categories: [] }], grab: async () => {} } }), llm, initialSettings: settings });
  return { runtime, store, settings, reads: () => indexerReads, get now() { return now; }, set now(value: number) { now = value; } };
}
function matched(f: ReturnType<typeof setup>, expires: number) {
  f.store.createSearch({ searchId: 'matched', prompt: '{"prompt":"Find Example"}', status: 'matched', createdAt: f.now, finishedAt: f.now, result: { options: [{ optionId: 'option', releases: [{ candidateId: 'candidate' }], rank: 1, reason: 'Fit', uncertainty: '', coveredTargetIds: [] }] } });
  f.store.addCandidate({ searchId: 'matched', candidateId: 'candidate', safe: {}, privateData: { release: releaseSchema.parse({ guid: 'private-locator', indexerId: 1, indexer: 'Test', title: 'Example', publishDate: '', protocol: 'torrent' }), physicalKey: 'physical' }, expiresAt: expires });
}

describe('search runtime', () => {
  it('filters Activity by persisted media context and inclusive creation-time bounds', () => {
    const f = setup();
    for (const [id, kind, createdAt] of [['tv', 'tv', f.now], ['movie', 'movie', f.now + 1], ['contextless', undefined, f.now + 2]] as const) {
      f.store.createSearch({ searchId: id, prompt: JSON.stringify({ prompt: id, ...(kind ? { context: { kind } } : {}) }), status: 'no-match', createdAt });
    }
    expect(f.runtime.activity({ kind: 'tv', createdAtFrom: new Date(f.now).toISOString(), createdAtTo: new Date(f.now + 1).toISOString() }).items.map(x => x.searchId)).toEqual(['tv']);
    expect(f.runtime.activity({ kind: 'other' }).items.map(x => x.searchId)).toEqual(['contextless']);
  });
  it('projects durable receipt evidence even if a crash prevented the Activity event', () => {
    const f = setup(); matched(f, f.now + 1000);
    f.store.appendEvent('matched', { type: 'submission', data: { outcome: 'dry-run', outcomes: [] } }, f.now - 1);
    f.store.beginSubmission({ idempotencyKey: 'crash', payload: { request: { searchId: 'matched', optionId: 'option' }, candidateIds: ['candidate'] }, createdAt: f.now });
    expect(f.runtime.activity({ status: 'uncertain' }).items[0]?.submission).toMatchObject({ outcome: 'uncertain' });
    f.store.updateSubmissionResult('crash', 'submitted', { outcomes: [{ candidateId: 'candidate', outcome: 'submitted' }] });
    expect(f.runtime.activity({ status: 'submitted' }).items[0]?.submission).toMatchObject({ outcome: 'submitted', outcomes: [{ candidateId: 'candidate', outcome: 'submitted' }] });
  });
  it('does not cache mixed-source observations when configuration changes during a read', async () => {
    const store = openSearchStore(':memory:'); stores.push(store);
    const settings = structuredClone(defaultSettings);
    settings.integrations.sonarr = { url: 'http://old-source', apiKey: 'old-key' };
    const calls: string[] = []; let release!: () => void;
    const runtime = new SearchRuntime({ store, initialSettings: settings, clients: current => ({ sonarr: {
      getSeries: async () => { calls.push(current.integrations.sonarr.url); await new Promise<void>(resolve => { release = resolve; }); return [{ id: 1, tvdbId: 20, title: 'Example', titleSlug: 'example', seriesType: 'anime', monitored: true, seasons: [], alternateTitles: [] }]; },
      getEpisodes: async () => { calls.push(current.integrations.sonarr.url); return []; }, getQueue: async () => [],
    } }) });
    const poll = runtime.poll();
    runtime.saveSettings({ ...settings, integrations: { ...settings.integrations, sonarr: { url: 'http://new-source', apiKey: 'new-key' } } });
    release(); await poll;
    expect(calls).toEqual(['http://old-source', 'http://old-source']);
    expect(runtime.automationStatus().providers.find(p => p.provider === 'sonarr')?.known).toBe(false);
  });
  it('keeps automated search target bindings so later manual submission revalidates fresh Arr state', async () => {
    const store = openSearchStore(':memory:'), settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://prowlarr', apiKey: 'private', tvClient: 'TV', movieClient: 'Movies' };
    settings.integrations.sonarr = { url: 'http://sonarr', apiKey: 'sonarr-secret' };
    settings.ai.apiKey = 'model-secret';
    settings.monitoring.enabled = true;
    settings.safety.dryRun = true;
    let hasFile = false, clock = 1_800_000_000_000;
    const release = releaseSchema.parse({ guid: 'release-guid', age: 1, size: null, files: null, grabs: null, indexerId: 1, indexer: 'Test', subGroup: null, title: 'Example S01E01', tvdbId: null, tmdbId: null, publishDate: '', downloadUrl: 'https://private.test/release', indexerFlags: [], categories: [], magnetUrl: null, infoHash: 'a'.repeat(40), seeders: 3, leechers: 0, protocol: 'torrent', downloadClientId: null });
    const clients = () => ({
      prowlarr: {
        getIndexers: async () => [{ id: 1, name: 'Test', enable: true }],
        getIndexerStatuses: async () => [],
        search: async () => [release],
        getDownloadClients: async () => [{ id: 7, name: 'TV', enable: true, protocol: 'torrent' as const, supportsCategories: false, categories: [] }],
        grab: async () => { throw new Error('must not grab after the episode imports'); },
      },
      sonarr: {
        getSeries: async () => [{ id: 1, tvdbId: 20, title: 'Example', titleSlug: 'example', seriesType: 'standard' as const, monitored: true, seasons: [], alternateTitles: [] }],
        getEpisodes: async () => [{ id: 2, seriesId: 1, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot', airDate: '2020-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile }],
        getQueue: async () => [],
      },
    } as RuntimeClients);
    const llm = { json: async ({ user }: { user: string }) => {
      const input = JSON.parse(user) as { candidates: Array<{ candidateId: string }>; request: { context?: { targets?: Array<{ targetId: string }> } } };
      if (!input.candidates.length) return { action: 'search_releases', query: 'Example S01E01', categories: [], indexerIds: [1], status: null, options: null, message: null };
      return { action: 'finish', query: null, categories: null, indexerIds: null, status: 'matched', options: [{ optionId: 'rank-one', rank: 1, releases: [{ candidateId: input.candidates[0]!.candidateId }], coveredTargetIds: input.request.context?.targets?.map(t => t.targetId) ?? [], reason: 'Correct episode', uncertainty: '' }], message: null };
    } } as unknown as LLMClient;
    const runtime = new SearchRuntime({ store, now: () => clock, initialSettings: settings, clients, llm });
    try {
      await runtime.poll();
      const item = runtime.activity().items[0];
      expect(item?.status).toBe('matched');
      expect(store.getSetting(`search-arr:${item!.searchId}`)).toMatchObject({ provider: 'sonarr', episodeId: 2 });
      hasFile = true;
      runtime.saveSettings({ ...settings, safety: { dryRun: false } });
      expect((await runtime.submit({ searchId: item!.searchId, optionId: 'rank-one', idempotencyKey: 'manual-after-import' })).outcome).toBe('failed');
    } finally { await runtime.close(); }
  });
  it('does not grab when automation is paused during fresh pre-submit validation', async () => {
    const store = openSearchStore(':memory:'), settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://prowlarr', apiKey: 'private', tvClient: 'TV', movieClient: 'Movies' };
    settings.integrations.sonarr = { url: 'http://sonarr', apiKey: 'sonarr-secret' };
    settings.ai.apiKey = 'model-secret';
    settings.safety.dryRun = false;
    let paused = false, episodeReads = 0, clock = 1_800_000_000_000;
    const episode = { id: 2, seriesId: 1, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot', airDate: '2020-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile: false };
    const release = releaseSchema.parse({ guid: 'release-guid', age: 1, size: null, files: null, grabs: null, indexerId: 1, indexer: 'Test', subGroup: null, title: 'Example S01E01', tvdbId: null, tmdbId: null, publishDate: '', downloadUrl: 'https://private.test/release', indexerFlags: [], categories: [], magnetUrl: null, infoHash: 'b'.repeat(40), seeders: 3, leechers: 0, protocol: 'torrent', downloadClientId: null });
    const grab = vi.fn(async () => {});
    const clients = () => ({
      prowlarr: { getIndexers: async () => [], getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [{ id: 7, name: 'TV', enable: true, protocol: 'torrent' as const, supportsCategories: false, categories: [] }], grab },
      sonarr: {
        getSeries: async () => [{ id: 1, tvdbId: 20, title: 'Example', titleSlug: 'example', seriesType: 'standard' as const, monitored: true, seasons: [], alternateTitles: [] }],
        getEpisodes: async () => { if (++episodeReads > 1) paused = true; return [episode]; },
        getQueue: async () => [],
      },
    } as RuntimeClients);
    const runtime = new SearchRuntime({ store, now: () => clock, initialSettings: settings, clients });
    try {
      await runtime.poll();
      const observation = store.getObservation('sonarr')?.payload as { targets: Array<{ key: string; provider: string }> };
      const target = observation.targets[0]!;
      store.createSearch({ searchId: 'automated', prompt: '{"context":{"kind":"tv"}}', status: 'matched', createdAt: clock, finishedAt: clock, result: { options: [{ optionId: 'rank-one', rank: 1, releases: [{ candidateId: 'candidate' }], coveredTargetIds: [], reason: 'Match', uncertainty: '' }] } });
      store.addCandidate({ searchId: 'automated', candidateId: 'candidate', safe: {}, privateData: { release, physicalKey: 'physical' }, expiresAt: clock + 60_000 });
      store.setSetting('search-arr:automated', target);
      const result = await runtime.submit({ searchId: 'automated', optionId: 'rank-one', idempotencyKey: 'pause-during-validation' }, { available: () => !paused });
      expect(result.outcome).toBe('failed');
      expect(paused).toBe(true);
      expect(grab).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });
  it('recovers an abandoned job after a restart within its still-live lease', async () => {
    const f = setup();
    f.store.createSearch({ searchId: 'abandoned', prompt: '{"prompt":"Find"}', status: 'running', createdAt: f.now });
    f.store.setSetting('search-owner:abandoned', 'old-process');
    f.store.acquireLease('search-worker', 'old-process', f.now, 900_000);
    expect((await f.runtime.getSearch('abandoned'))?.status).toBe('running');
    f.now += 900_001;
    expect((await f.runtime.getSearch('abandoned'))?.status).toBe('interrupted');
  });
  it('actually removes expired private material and old history while preserving receipts', () => {
    const f = setup(); matched(f, f.now - 1);
    f.store.createSearch({ searchId: 'old', prompt: 'old', status: 'no-match', createdAt: f.now - 31 * 86_400_000 });
    f.store.setSetting('search-source:old', 'manual');
    f.store.beginSubmission({ idempotencyKey: 'retained', payload: { searchId: 'old' }, createdAt: f.now - 31 * 86_400_000 });
    f.runtime.activity();
    expect(f.store.getSearch('old')).toBeNull();
    expect(f.store.getSetting('search-source:old')).toBeNull();
    expect(f.store.getCandidate('matched', 'candidate', 0)).toBeNull();
    expect(f.store.getSubmission('retained')).not.toBeNull();
  });
  it('rejects extreme deadlines instead of accepting settings that break ISO projections', () => {
    const f = setup();
    expect(f.runtime.saveSettings({ ...f.settings, monitoring: { ...f.settings.monitoring, minRetryHours: 1_000_000_000_000_000 } }).ok).toBe(false);
  });
  it('reports expiry distinctly and records dry-run confirmation outcomes in Activity', async () => {
    const f = setup(); matched(f, f.now - 1);
    f.runtime.saveSettings({ ...f.settings, safety: { dryRun: false } });
    expect((await f.runtime.submit({ searchId: 'matched', optionId: 'option', idempotencyKey: 'expired', downloadClientId: 7 })).outcome).toBe('expired');
    f.store.expireCandidatesAt('matched', f.now + 1000);
    f.runtime.saveSettings(f.settings);
    expect((await f.runtime.submit({ searchId: 'matched', optionId: 'option', idempotencyKey: 'dry-run', downloadClientId: 7 })).outcome).toBe('dry-run');
    const activity = f.runtime.activity({ status: 'dry-run' });
    expect(activity.total).toBe(1);
    expect(activity.items[0]?.submission).toMatchObject({ outcome: 'dry-run' });
  });
  it('uses strict version 2 settings and requires only standalone search integrations', async () => {
    const { runtime, settings } = setup();
    expect(runtime.getSettings()).toEqual(settings);
    expect(runtime.missingSettings()).toEqual([]);
    expect(runtime.missingSettings({ ...settings, integrations: { ...settings.integrations, prowlarr: { ...settings.integrations.prowlarr, apiKey: '' } } })).toContain('integrations.prowlarr.apiKey');
    expect(runtime.saveSettings({ ...settings, version: 1 })).toMatchObject({ ok: false });
  });

  it('persists validated settings and reports current readiness', () => {
    const { runtime, settings, store } = setup();
    const next = { ...settings, safety: { dryRun: false } };
    expect(runtime.saveSettings(next)).toEqual({ ok: true, settings: next });
    expect(store.getSetting('application-settings')).toEqual(next);
    expect(runtime.getSettings()).toEqual(next);
  });

  it('returns an id immediately, then exposes safe flat status without requiring Arr', async () => {
    const { runtime, reads } = setup();
    const started = runtime.startSearch({ prompt: 'Find a film' });
    expect(started.searchId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(started.status).toBe('running');
    await runtime.drain();
    const result = await runtime.getSearch(started.searchId);
    expect(result).toMatchObject({ searchId: started.searchId, status: 'no-match', prompt: 'Find a film', counts: { decisions: 1, searches: 0 } });
    expect(result?.createdAt).toEqual(new Date(1_800_000_000_000).toISOString());
    expect(reads()).toBe(1);
  });

  it('keeps status and activity reads offline and projects activity safely', async () => {
    const { runtime, reads } = setup();
    const started = runtime.startSearch({ prompt: 'Find a film' });
    await runtime.drain();
    const before = reads();
    expect(await runtime.getSearch('not-found')).toBeNull();
    const activity = runtime.activity();
    expect(activity.items[0]).toMatchObject({ searchId: started.searchId, prompt: 'Find a film', status: 'no-match', source: 'manual' });
    expect(activity.retention).toEqual({ days: 30, maxEntries: 10000 });
    expect(reads()).toBe(before);
  });
});
