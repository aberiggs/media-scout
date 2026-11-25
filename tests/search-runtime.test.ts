import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSearchStore } from '../src/search/store';
import { SearchRuntime } from '../src/search/runtime';
import { defaultSettings, type Settings } from '../src/search/settings';
import { releaseSchema } from '../src/types/prowlarr';
import { arrFingerprint } from '../src/search/arr';

const stores: ReturnType<typeof openSearchStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = openSearchStore(':memory:'); stores.push(store);
  const settings = { ...defaultSettings, integrations: { ...defaultSettings.integrations, prowlarr: { ...defaultSettings.integrations.prowlarr, url: 'http://localhost:9696', apiKey: 'private' }, sonarr: { url: 'http://sonarr.test', apiKey: 'fixture' } }, ai: { apiKey: 'private-ai', model: 'test/model', baseUrl: 'https://example.test/v1', preferences: '' }, search: { maxDecisions: 20, maxSearches: 12, deadlineMinutes: 10, concurrentSearches: 3 } } satisfies Settings;
  let indexerReads = 0;
  let now = 1_800_000_000_000;
  const runtime = new SearchRuntime({ store, now: () => now, clients: () => ({ prowlarr: { getIndexers: async () => { indexerReads++; return [{ id: 1, name: 'Test', enable: true }]; }, getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [{ id: 7, name: 'TV', enable: true, protocol: 'torrent', supportsCategories: false, categories: [] }], grab: async () => {} } }), initialSettings: settings });
  return { runtime, store, settings, sonarrSource: arrFingerprint('sonarr', { id: 'sonarr', ...settings.integrations.sonarr }), reads: () => indexerReads, get now() { return now; }, set now(value: number) { now = value; } };
}
function matched(f: ReturnType<typeof setup>, expires: number) {
  f.store.createSearch({ searchId: 'matched', prompt: '{"request":{"prompt":"Find Example"}}', status: 'matched', createdAt: f.now, finishedAt: f.now, result: { version: 1, plan: { version: 2 } } });
  f.store.addCandidate({ searchId: 'matched', candidateId: 'candidate', safe: {}, privateData: { release: releaseSchema.parse({ guid: 'private-locator', indexerId: 1, indexer: 'Test', title: 'Example', publishDate: '', protocol: 'torrent' }), physicalKey: 'physical' }, expiresAt: expires });
}

describe('search runtime', () => {
  it('retains all completed evidence while private candidates expire at different times', async () => {
    const f = setup();
    const evidence = ['early', 'late'].map(candidateId => ({ candidateId, observations: [{ title: `${candidateId} release` }] }));
    f.store.createSearch({ searchId: 'staggered', prompt: '{"prompt":"Find"}', status: 'matched', createdAt: f.now,
      result: { version: 1, candidateEvidence: evidence, counts: { decisions: 2, searches: 2, candidates: 2 } } });
    for (const [index, safe] of evidence.entries()) f.store.addCandidate({
      searchId: 'staggered', candidateId: safe.candidateId, safe, privateData: {},
      expiresAt: f.now + (index + 1) * 1000,
    });
    f.now += 1001;
    expect(f.store.listCandidates('staggered', f.now)).toHaveLength(1);
    expect((await f.runtime.getSearch('staggered'))!.candidates).toEqual(evidence);
  });
  it('does not apply the retired show-wide cooldown to an individual actionable target', () => {
    const f = setup();
    const deadline = f.now + 120_000, target = { key: `sonarr:${f.sonarrSource}:7:20:2`, provider: 'sonarr', sourceFingerprint: f.sonarrSource, serviceId: 7, externalId: 20, episodeId: 2, monitored: true, hasFile: false, airAt: f.now - 1000, queued: false, context: { title: 'Show', seasonNumber: 3, episodeNumber: 2 } };
    f.store.saveObservation('sonarr', { observedAt: f.now, complete: true, payload: { targets: [target] } });
    f.store.setSetting(`automation:show-cooldown:${f.sonarrSource}:7`, deadline);
    expect(f.runtime.automationStatus().items[0]).toMatchObject({ status: 'missing', eligible: true });
  });
  it('rejects former preference fields from the public search contract', async () => {
    const { searchRequestSchema } = await import('../src/search/contracts');
    expect(searchRequestSchema.safeParse({ prompt: 'Find', preferences: { notes: 'old preference' } }).success).toBe(false);
  });
  it('durably queues requests in FIFO order and shares a three-search execution cap', () => {
    const f = setup();
    for (let i = 1; i <= 4; i++) f.store.enqueueSearch({ searchId: `queued-${i}`, prompt: JSON.stringify({prompt:`Find ${i}`}), now: f.now + i });
    const claims = [1, 2, 3].map(i => f.store.claimNextSearch(`owner-${i}`, f.now + 10, 90_000));
    expect(claims.map(work => work?.searchId)).toEqual(['queued-1', 'queued-2', 'queued-3']);
    expect(f.store.claimNextSearch('owner-4', f.now + 10, 90_000)).toBeNull();
    expect(f.store.queuePosition('queued-4')).toBe(1);
  });
  it('arbitrates the shared concurrency cap across independent SQLite connections', () => {
    const dir=mkdtempSync(join(tmpdir(),'media-scout-queue-')), path=join(dir,'search.db');
    const first=openSearchStore(path), second=openSearchStore(path);
    try {
      for(let i=1;i<=4;i++) first.enqueueSearch({searchId:`shared-${i}`,prompt:JSON.stringify({prompt:`Find ${i}`}),now:i});
      const claims=[
        first.claimNextSearch('runtime-a',10,90_000),
        second.claimNextSearch('runtime-b',10,90_000),
        first.claimNextSearch('runtime-a2',10,90_000),
        second.claimNextSearch('runtime-b2',10,90_000),
      ];
      expect(claims.map(work=>work?.searchId ?? null)).toEqual(['shared-1','shared-2','shared-3',null]);
      expect(second.queuePosition('shared-4')).toBe(1);
    } finally { first.close(); second.close(); rmSync(dir,{recursive:true,force:true}); }
  });
  it('reports queue positions in the same manual-before-automation order used for dispatch', () => {
    const f=setup();
    f.store.enqueueSearch({searchId:'automation-first',prompt:'{}',now:f.now,source:'automation'});
    f.store.enqueueSearch({searchId:'manual-second',prompt:'{}',now:f.now+1});
    expect(f.store.queuePosition('manual-second')).toBe(1);
    expect(f.store.queuePosition('automation-first')).toBe(2);
  });
  it('never lets the general dispatcher claim automation work', () => {
    const { store, now } = setup();
    store.enqueueSearch({ searchId: 'auto', prompt: '{}', now, source: 'automation' });
    store.enqueueSearch({ searchId: 'manual', prompt: '{}', now: now + 1, source: 'manual' });
    expect(store.claimNextSearch('worker', now, 1000)?.searchId).toBe('manual');
    expect(store.claimAutomationSearchById('auto', 'auto-worker', now, 1000)?.searchId).toBe('auto');
  });
  it('interrupts queued automation rows rather than replaying them after restart', () => {
    const { store, now } = setup();
    store.enqueueSearch({ searchId: 'stranded-auto', prompt: '{}', now, source: 'automation' });
    store.interruptQueuedAutomation(now + 1);
    expect(store.getSearch('stranded-auto')?.status).toBe('interrupted');
    expect(store.claimAutomationSearchById('stranded-auto', 'worker', now + 2, 1000)).toBeNull();
  });
  it('never shortens a provider cooldown when concurrent responses arrive out of order', () => {
    const f = setup();
    f.store.setProviderDeadline('prowlarr', f.now + 60_000);
    f.store.setProviderDeadline('prowlarr', f.now + 5_000);
    expect(f.store.getProviderDeadline('prowlarr')).toBe(f.now + 60_000);
  });
  it('does not accept work without a bound daemon MCP listener', async () => {
    const f = setup();
    f.store.setProviderDeadline('prowlarr', f.now + 60_000);
    await expect(f.runtime.startSearch({ prompt: 'Find Example' })).rejects.toThrow('daemon-mcp-unavailable');
    expect(f.reads()).toBe(0);
  });
  it('recovers expired work during status maintenance without requiring provider readiness', async () => {
    const f = setup();
    f.store.enqueueSearch({ searchId: 'expired-work', prompt: JSON.stringify({prompt:'Find Example'}), now: f.now });
    f.store.claimNextSearch('dead-worker', f.now, 1000);
    f.now += 1001;
    expect((await f.runtime.getSearch('expired-work'))?.status).toBe('interrupted');
    expect(f.store.getSearch('expired-work')?.result).toMatchObject({ message: expect.stringMatching(/lease expired/i) });
  });
  it('renews only a live owned search-work lease', () => {
    const f = setup();
    f.store.enqueueSearch({ searchId: 'heartbeat', prompt: '{}', now: f.now });
    expect(f.store.claimNextSearch('owner', f.now, 10_000)?.searchId).toBe('heartbeat');
    expect(f.store.renewSearchWork('heartbeat', 'other', f.now + 1, 20_000)).toBe(false);
    expect(f.store.renewSearchWork('heartbeat', 'owner', f.now + 1, 20_000)).toBe(true);
    expect(f.store.ownsSearch('heartbeat', 'owner', f.now + 10_001)).toBe(true);
    expect(f.store.renewSearchWork('heartbeat', 'owner', f.now + 30_002, 20_000)).toBe(false);
  });
  it('preserves live peer-owned searches and queued requests during another runtime startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'media-scout-peer-')), path = join(dir, 'search.db');
    const first = openSearchStore(path);
    const now = Date.now();
    let peer: SearchRuntime | undefined;
    try {
      first.enqueueSearch({searchId:'live-peer',prompt:'{}',now});
      first.enqueueSearch({searchId:'still-queued',prompt:'{}',now:now+1});
      first.claimNextSearch('peer-owner',now,90_000);
      peer = new SearchRuntime({ databasePath: path, now: () => now + 2 });
      expect(first.getSearch('live-peer')?.status).toBe('running');
      expect(first.getSearch('still-queued')?.status).toBe('queued');
      expect(first.queuePosition('still-queued')).toBe(1);
    } finally { await peer?.close(); first.close(); rmSync(dir,{recursive:true,force:true}); }
  });
  it('filters Activity by persisted media context and inclusive creation-time bounds', () => {
    const f = setup();
    for (const [id, kind, createdAt] of [['tv', 'tv', f.now], ['movie', 'movie', f.now + 1], ['contextless', undefined, f.now + 2]] as const) {
      f.store.createSearch({ searchId: id, prompt: JSON.stringify({ prompt: id, ...(kind ? { context: { kind } } : {}) }), status: 'no-match', createdAt });
    }
    expect(f.runtime.activity({ kind: 'tv', createdAtFrom: new Date(f.now).toISOString(), createdAtTo: new Date(f.now + 1).toISOString() }).items.map(x => x.searchId)).toEqual(['tv']);
    expect(f.runtime.activity({ kind: 'other' }).items.map(x => x.searchId)).toEqual(['contextless']);
  });
  it('omits retired results from Activity and direct detail without disturbing current results', async () => {
    const f = setup();
    matched(f, f.now + 1000);
    for (const [searchId, result] of [['old-options', { options: [] }], ['old-plan', { version: 1, plan: { version: 1 } }]] as const) {
      f.store.createSearch({ searchId, prompt: '{}', status: 'matched', createdAt: f.now, result });
      expect(await f.runtime.getSearch(searchId)).toBeNull();
    }
    expect(f.runtime.activity()).toMatchObject({ total: 1, items: [{ searchId: 'matched' }] });
    expect((await f.runtime.getSearch('matched'))?.plan?.version).toBe(2);
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
  it('shows monitored missing work while preserving timing, queued and cooldown states', () => {
    const f = setup();
    const target = (key: string, airAt: number | undefined, queued = false) => ({
      key, provider: 'sonarr' as const, sourceFingerprint: f.sonarrSource, serviceId: 1, externalId: 20, episodeId: 1,
      monitored: true, hasFile: false, airAt, queued, context: { title: key, seasonNumber: 1, episodeNumber: 1 },
    });
    const targets = [
      target('future', f.now + 1000),
      target('unknown-airtime', undefined),
      target('available', f.now - 1000),
      target('queued', f.now - 1000, true),
      target('cooldown', f.now - 1000),
    ];
    f.store.saveObservation('sonarr', { observedAt: f.now, complete: true, payload: { observedAt: f.now, targets, queue: [], diagnostics: { unidentifiedQueueRows: 0 } } });
    f.store.saveObservation('radarr', { observedAt: f.now, complete: true, payload: { observedAt: f.now, targets: [], queue: [], diagnostics: { unidentifiedQueueRows: 0 } } });
    f.store.setAutomationAttempt('cooldown', { lastAttempt: f.now, failCount: 0, deadline: f.now + 60_000, graceUntil: 0 });

    const items = f.runtime.automationStatus().items;
    expect(Object.fromEntries(items.map(item => [item.title, item.status]))).toEqual({
      future: 'upcoming', 'unknown-airtime': 'no-air-date', available: 'missing', queued: 'downloading', cooldown: 'cooldown',
    });
  });
  it('actually removes expired private material and old history', () => {
    const f = setup(); matched(f, f.now - 1);
    f.store.enqueueSearch({ searchId: 'new', prompt: 'new prompt', now: f.now, context: { targetBindings: [{ secret: 'private' }] } });
    expect(f.store.getSetting('search-arr-bindings-v1:new')).toBeNull();
    f.store.createSearch({ searchId: 'old', prompt: 'old', status: 'no-match', createdAt: f.now - 31 * 86_400_000 });
    f.store.setSetting('search-source:old', 'manual');
    f.store.setSetting('search-arr-bindings-v1:old', [{ secret: 'historic private' }]);
    f.runtime.activity();
    expect(f.store.getSearch('old')).toBeNull();
    expect(f.store.getSetting('search-source:old')).toBeNull();
    expect(f.store.getSetting('search-arr-bindings-v1:old')).toBeNull();
    expect(f.store.getCandidate('matched', 'candidate', 0)).toBeNull();
  });
  it('rejects extreme retry intervals instead of accepting settings that break ISO projections', () => {
    const f = setup();
    expect(f.runtime.saveSettings({ ...f.settings, monitoring: { ...f.settings.monitoring, searchRetryMinutes: 1_000_000_000_000_000 } }).ok).toBe(false);
  });
  it('uses strict current settings and requires only standalone search integrations', async () => {
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

  it('requires a daemon MCP listener and leaves no work queued when unavailable', async () => {
    const { runtime, reads } = setup();
    await expect(runtime.startSearch({ prompt: 'Find a film' })).rejects.toThrow('daemon-mcp-unavailable');
    expect(runtime.activity().items).toHaveLength(0);
    expect(reads()).toBe(0);
  });

  it('keeps status and activity reads offline and projects activity safely', async () => {
    const { runtime, reads } = setup();
    runtime.store.createSearch({ searchId: 'offline-read', prompt: '{"prompt":"Find a film"}', status: 'no-match', createdAt: 1_800_000_000_000 });
    const before = reads();
    expect(await runtime.getSearch('not-found')).toBeNull();
    const activity = runtime.activity();
    expect(activity.items[0]).toMatchObject({ searchId: 'offline-read', prompt: 'Find a film', status: 'no-match', source: 'manual' });
    expect(activity.retention).toEqual({ days: 30, maxEntries: 10000 });
    expect(reads()).toBe(before);
  });
});
