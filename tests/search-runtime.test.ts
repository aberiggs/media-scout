import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSearchStore } from '../src/search/store';
import { SearchRuntime, type RuntimeClients } from '../src/search/runtime';
import { defaultSettings, type Settings } from '../src/search/settings';
import type { LLMClient } from '../src/clients/llm';
import { releaseSchema } from '../src/types/prowlarr';

const stores: ReturnType<typeof openSearchStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = openSearchStore(':memory:'); stores.push(store);
  const settings = { version: 3, integrations: { prowlarr: { url: 'http://localhost:9696', apiKey: 'private', tvClient: '', movieClient: '' }, sonarr: { url: '', apiKey: '' }, radarr: { url: '', apiKey: '' } }, ai: { apiKey: 'private-ai', model: 'test/model', baseUrl: 'https://example.test/v1', preferences: '' }, monitoring: { enabled: false, intervalMinutes: 5, searchRetryMinutes: 30, failureBackoffMinMinutes: 5, failureBackoffMaxMinutes: 60, queueGraceMinutes: 30 }, search: { maxDecisions: 20, maxSearches: 12, deadlineMinutes: 10 }, safety: { dryRun: true } } satisfies Settings;
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
  it('durably queues requests in FIFO order and shares a three-search execution cap', () => {
    const f = setup();
    for (let i = 1; i <= 4; i++) f.store.enqueueSearch({ searchId: `queued-${i}`, prompt: JSON.stringify({prompt:`Find ${i}`}), now: f.now + i });
    const claims = [1, 2, 3].map(i => f.store.claimNextSearch(`owner-${i}`, f.now + 10, 90_000));
    expect(claims.map(work => work?.searchId)).toEqual(['queued-1', 'queued-2', 'queued-3']);
    expect(f.store.claimNextSearch('owner-4', f.now + 10, 90_000)).toBeNull();
    expect(f.store.startAutomationSearch({searchId:'automation-fourth',prompt:'{}',owner:'automation',now:f.now+10,ttl:90_000,maxActive:3,context:{}})).toBeNull();
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
  it('defers automation behind queued manual work instead of creating orphaned automation jobs', () => {
    const f=setup();
    f.store.enqueueSearch({searchId:'manual-backlog',prompt:'{}',now:f.now});
    const work=f.store.startAutomationSearch({searchId:'automation-attempt',prompt:'{}',owner:'automation-owner',now:f.now,ttl:90_000,maxActive:3,context:{targetKeys:['sonarr:item']}});
    expect(work).toBeNull();
    expect(f.store.getSearch('automation-attempt')).toBeNull();
    expect(f.store.queuePosition('manual-backlog')).toBe(1);
  });
  it('never shortens a provider cooldown when concurrent responses arrive out of order', () => {
    const f = setup();
    f.store.setProviderDeadline('prowlarr', f.now + 60_000);
    f.store.setProviderDeadline('prowlarr', f.now + 5_000);
    expect(f.store.getProviderDeadline('prowlarr')).toBe(f.now + 60_000);
  });
  it('keeps queued requests off cooldown-bound providers and exposes the retry time', async () => {
    const f = setup();
    f.store.setProviderDeadline('prowlarr', f.now + 60_000);
    const started = f.runtime.startSearch({ prompt: 'Find Example' });
    const status = await f.runtime.getSearch(started.searchId);
    expect(status).toMatchObject({ status: 'queued', waitingReason: 'provider-cooldown', retryAt: new Date(f.now + 60_000).toISOString() });
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
    const runtime = new SearchRuntime({ store, now: () => now, initialSettings: legacy as Settings, llm: {} as LLMClient });
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
  it('persists manual Arr target bindings before queued execution for fresh submission validation', async () => {
    const store=openSearchStore(':memory:'), settings=structuredClone(defaultSettings);
    settings.integrations.prowlarr={url:'http://prowlarr',apiKey:'private',tvClient:'TV',movieClient:'Movies'};
    settings.integrations.sonarr={url:'http://sonarr',apiKey:'sonarr-secret'};
    settings.ai.apiKey='model-secret';
    let hasFile=false, clock=1_800_000_000_000;
    const release=releaseSchema.parse({guid:'manual-release',age:1,size:null,files:null,grabs:null,indexerId:1,indexer:'Test',subGroup:null,title:'Example S01E01',tvdbId:null,tmdbId:null,publishDate:'',downloadUrl:'https://private.test/release',indexerFlags:[],categories:[],magnetUrl:null,infoHash:'c'.repeat(40),seeders:3,leechers:0,protocol:'torrent',downloadClientId:null});
    const clients=()=>({
      prowlarr:{getIndexers:async()=>[{id:1,name:'Test',enable:true}],getIndexerStatuses:async()=>[],search:async()=>[release],getDownloadClients:async()=>[],grab:async()=>{throw new Error('must not grab imported media');}},
      sonarr:{getSeries:async()=>[{id:1,tvdbId:20,title:'Example',titleSlug:'example',seriesType:'standard' as const,monitored:true,seasons:[],alternateTitles:[]}],getEpisodes:async()=>[{id:2,seriesId:1,seasonNumber:1,episodeNumber:1,absoluteEpisodeNumber:null,title:'Pilot',airDate:'2020-01-01',airDateUtc:null,finaleType:null,monitored:true,hasFile}],getQueue:async()=>[]},
    } as RuntimeClients);
    const llm={json:async({user}:{user:string})=>{const input=JSON.parse(user) as {candidates:Array<{candidateId:string}>};return input.candidates.length?{action:'finish',query:null,categories:null,indexerIds:null,status:'matched',options:[{optionId:'rank-one',rank:1,releases:[{candidateId:input.candidates[0]!.candidateId}],coveredTargetIds:[],reason:'match',uncertainty:''}],message:null}:{action:'search_releases',query:'Example S01E01',categories:[],indexerIds:[1],status:null,options:null,message:null};}} as unknown as LLMClient;
    const runtime=new SearchRuntime({store,now:()=>clock,initialSettings:settings,clients,llm});
    try {
      await runtime.poll();
      const targetId=runtime.automationStatus().items[0]!.targetId;
      settings.safety.dryRun=false;
      const started=await runtime.startArrSearch(targetId);
      expect(store.getSetting(`search-arr:${started.searchId}`)).toMatchObject({provider:'sonarr',episodeId:2});
      await runtime.drain();
      hasFile=true; runtime.saveSettings(settings);
      expect((await runtime.submit({searchId:started.searchId,optionId:'rank-one',idempotencyKey:'manual-arr-validation'})).outcome).toBe('rejected');
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

  it('returns an id immediately, then exposes safe flat status without requiring Arr', async () => {
    const { runtime, reads } = setup();
    const started = runtime.startSearch({ prompt: 'Find a film' });
    expect(started.searchId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(started.status).toBe('queued');
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
