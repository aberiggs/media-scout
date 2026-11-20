import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSearchStore } from '../src/search/store';
import { SearchRuntime } from '../src/search/runtime';
import { showCooldownSettingKey } from '../src/search/automation';
import { defaultSettings, type Settings } from '../src/search/settings';
import { releaseSchema } from '../src/types/prowlarr';

const stores: ReturnType<typeof openSearchStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = openSearchStore(':memory:'); stores.push(store);
  const settings = { version: 3, integrations: { prowlarr: { url: 'http://localhost:9696', apiKey: 'private', tvClient: '', movieClient: '' }, sonarr: { url: '', apiKey: '' }, radarr: { url: '', apiKey: '' } }, ai: { apiKey: 'private-ai', model: 'test/model', baseUrl: 'https://example.test/v1', preferences: '' }, monitoring: { enabled: false, intervalMinutes: 5, searchRetryMinutes: 30, failureBackoffMinMinutes: 5, failureBackoffMaxMinutes: 60, queueGraceMinutes: 30 }, search: { maxDecisions: 20, maxSearches: 12, deadlineMinutes: 10 }, safety: { dryRun: true } } satisfies Settings;
  let indexerReads = 0;
  let now = 1_800_000_000_000;
  const runtime = new SearchRuntime({ store, now: () => now, clients: () => ({ prowlarr: { getIndexers: async () => { indexerReads++; return [{ id: 1, name: 'Test', enable: true }]; }, getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [{ id: 7, name: 'TV', enable: true, protocol: 'torrent', supportsCategories: false, categories: [] }], grab: async () => {} } }), initialSettings: settings });
  return { runtime, store, settings, reads: () => indexerReads, get now() { return now; }, set now(value: number) { now = value; } };
}
function matched(f: ReturnType<typeof setup>, expires: number) {
  f.store.createSearch({ searchId: 'matched', prompt: '{"prompt":"Find Example"}', status: 'matched', createdAt: f.now, finishedAt: f.now, result: { options: [{ optionId: 'option', releases: [{ candidateId: 'candidate' }], rank: 1, reason: 'Fit', uncertainty: '', coveredTargetIds: [] }] } });
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
  it('projects a source-scoped show cooldown in automation status', () => {
    const f = setup();
    const deadline = f.now + 120_000, target = { key: 'sonarr:fp:7:20:2', provider: 'sonarr', sourceFingerprint: 'fp', serviceId: 7, externalId: 20, episodeId: 2, monitored: true, hasFile: false, available: true, eligible: true, context: { title: 'Show', seasonNumber: 3, episodeNumber: 2 } };
    f.store.saveObservation('sonarr', { observedAt: f.now, complete: true, payload: { targets: [target] } });
    f.store.setSetting(showCooldownSettingKey('fp', 7), deadline);
    expect(f.runtime.automationStatus().items[0]).toMatchObject({ status: 'cooldown', eligible: false, nextAttemptAt: new Date(deadline).toISOString() });
  });
  it('rejects per-request preference notes longer than 4000 characters', async () => {
    const f = setup();
    await expect(f.runtime.startSearch({ prompt: 'Find', preferences: { notes: 'x'.repeat(4001) } })).rejects.toThrow();
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
  it('preserves live peer-owned searches and queued requests during another runtime startup', () => {
    const f = setup();
    f.store.enqueueSearch({searchId:'live-peer',prompt:'{}',now:f.now});
    f.store.enqueueSearch({searchId:'still-queued',prompt:'{}',now:f.now+1});
    f.store.claimNextSearch('peer-owner',f.now,90_000);
    f.store.migrateLegacySearchWork(f.now+2);
    expect(f.store.getSearch('live-peer')?.status).toBe('running');
    expect(f.store.getSearch('still-queued')?.status).toBe('queued');
    expect(f.store.queuePosition('still-queued')).toBe(1);
  });
  it('migrates saved v2 settings and shortens only legacy search-only deadlines once', async () => {
    const store = openSearchStore(':memory:'); stores.push(store);
    const now = 1_800_000_000_000, longDeadline = now + 6 * 60 * 60_000;
    const legacy = { ...defaultSettings, version: 2, monitoring: { ...defaultSettings.monitoring, minRetryHours: 6 } };
    store.setSetting('application-settings', legacy);
    for (const target of ['search', 'grab']) {
      store.setAutomationAttempt(target, { lastAttempt: now - 5 * 60_000, failCount: 0, deadline: longDeadline, graceUntil: 0 });
      store.setDeadline(target, longDeadline);
    }
    store.createSearch({ searchId: 'legacy-search', prompt: 'Find', status: 'matched', createdAt: now });
    store.setSetting('search-arr:legacy-search', { key: 'search' });
    store.setSetting('search-source:legacy-search', 'automation');
    store.createSearch({ searchId: 'legacy-grab', prompt: 'Find', status: 'matched', createdAt: now });
    store.setSetting('search-arr:legacy-grab', { key: 'grab' });
    store.setSetting('search-source:legacy-grab', 'automation');
    store.recordSubmission({ idempotencyKey: 'receipt', payload: { targets: ['grab'] }, outcome: 'submitted', createdAt: now });
    const runtime = new SearchRuntime({ store, now: () => now, initialSettings: legacy as Settings });
    expect(runtime.getSettings()).toMatchObject({ version: 3, monitoring: { searchRetryMinutes: 30 } });
    expect(store.getAutomationAttempt('search')?.deadline).toBe(now + 25 * 60_000);
    expect(store.getDeadline('search')).toBe(now + 25 * 60_000);
    expect(store.getAutomationAttempt('grab')?.deadline).toBe(longDeadline);
    await runtime.close();
  });
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
  it('shows only available missing work while retaining available queued and cooldown items', () => {
    const f = setup();
    const target = (key: string, available: boolean, eligible: boolean, overrides: Record<string, unknown> = {}) => ({
      key, provider: 'sonarr' as const, sourceFingerprint: 'source', serviceId: 1, externalId: 20, episodeId: 1,
      monitored: true, hasFile: false, available, eligible,
      context: { title: key, seasonNumber: 1, episodeNumber: 1 }, ...overrides,
    });
    const targets = [
      target('future', false, false),
      target('unknown-airtime', false, false),
      target('available', true, true),
      target('queued', true, false),
      target('cooldown', true, true),
    ];
    f.store.saveObservation('sonarr', { observedAt: f.now, complete: true, payload: { observedAt: f.now, targets, queue: [], diagnostics: { unidentifiedQueueRows: 0 } } });
    f.store.saveObservation('radarr', { observedAt: f.now, complete: true, payload: { observedAt: f.now, targets: [], queue: [], diagnostics: { unidentifiedQueueRows: 0 } } });
    f.store.setAutomationAttempt('cooldown', { lastAttempt: f.now, failCount: 0, deadline: f.now + 60_000, graceUntil: 0 });
    f.store.setDeadline('cooldown', f.now + 60_000);

    const items = f.runtime.automationStatus().items;
    expect(items.map(item => item.title).sort()).toEqual(['available', 'cooldown', 'queued']);
    expect(items.find(item => item.title === 'queued')?.status).toBe('downloading');
    expect(items.find(item => item.title === 'cooldown')?.status).toBe('cooldown');
  });
  it('interrupts legacy abandoned jobs instead of trusting the obsolete global worker lease', async () => {
    const f = setup();
    f.store.createSearch({ searchId: 'abandoned', prompt: '{"prompt":"Find"}', status: 'running', createdAt: f.now });
    f.store.setSetting('search-owner:abandoned', 'old-process');
    f.store.acquireLease('search-worker', 'old-process', f.now, 900_000);
    expect((await f.runtime.getSearch('abandoned'))?.status).toBe('interrupted');
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
  it('rejects extreme retry intervals instead of accepting settings that break ISO projections', () => {
    const f = setup();
    expect(f.runtime.saveSettings({ ...f.settings, monitoring: { ...f.settings.monitoring, searchRetryMinutes: 1_000_000_000_000_000 } }).ok).toBe(false);
  });
  it('blocks execution regardless of saved dry-run policy', async () => {
    const f = setup(); matched(f, f.now - 1);
    f.runtime.saveSettings({ ...f.settings, safety: { dryRun: false } });
    expect((await f.runtime.submit({ searchId: 'matched', optionId: 'option', idempotencyKey: 'blocked', downloadClientId: 7 })).outcome).toBe('deferred');
    expect(f.runtime.getSettings().safety.dryRun).toBe(false);
  });
  it('uses strict version 3 settings and requires only standalone search integrations', async () => {
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
