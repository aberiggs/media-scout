import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/daemon';
import type { Stack } from '../src/compose';
import { State } from '../src/core/state';
import { GeneralSearchService } from '../src/core/general-search';
import { defaultSettings } from '../src/settings';
import type { Release } from '../src/types/prowlarr';
import { downloadClientSchema } from '../src/types/prowlarr';
import { ApiError } from '../src/http';

const release = (overrides: Partial<Release> = {}): Release => ({
  guid: 'private-guid', age: 1, size: 123, files: null, grabs: null, indexerId: 8, indexer: 'Indexer', subGroup: null,
  title: 'Example release', tvdbId: null, tmdbId: null, publishDate: '', downloadUrl: 'https://private.test/apikey=secret',
  indexerFlags: [], categories: [], magnetUrl: 'magnet:?xt=private', infoHash: 'private-hash', seeders: 10, leechers: 2,
  protocol: 'torrent', downloadClientId: null, ...overrides,
});
const planned = (...queries: string[]) => ({ mode: 'search', question: '', searchSpace: { focus: 'category', identityAnchors: [], medium: { value: null, provenance: 'unknown' }, positives: [], negatives: [], expansionScope: 'subcategories' }, proposals: queries.map((query) => ({ query, purpose: 'Search this topic', branch: 'topic', strategy: 'subcategory', preserves: [] })) });

function fixture(opts: { dryRun?: boolean; allow?: boolean } = {}) {
  const state = State.open(':memory:');
  const settings = structuredClone(defaultSettings);
  settings.integrations.prowlarr = { url: 'http://prowlarr.test', apiKey: 'private-api-key', tvClient: '', movieClient: '', generalClient: 'General' };
  settings.ai.apiKey = 'private-llm-key'; settings.safety.dryRun = opts.dryRun ?? false; settings.safety.allowOperatorActions = opts.allow ?? true;
  state.saveSettings(settings);
  const llm = { json: vi.fn(async (_args: { user: string }) => planned('query one', 'query two')) };
  const client = { id: 41, name: 'General', enable: true, protocol: 'torrent' as const, supportsCategories: true, categories: [] as Array<{clientCategory: string | null; categories: number[] | null}>, routingDigest: 'a'.repeat(64) };
  const prowlarr = {
    search: vi.fn(async ({ query }: {query:string}) => [release({ guid: query === 'query one' ? 'same' : 'same' }), release({ guid: 'other', protocol: 'torrent' })]),
    getDownloadClients: vi.fn(async () => [client]),
    grabGeneral: vi.fn(async () => {}),
  };
  let clock = new Date('2026-10-06T00:00:00.000Z');
  const service = new GeneralSearchService({ llm: llm as never, prowlarr: prowlarr as never, state, getSettings: () => state.getSettings(), now: () => new Date(clock) });
  return { state, settings, llm, client, prowlarr, service, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

describe('LLM-assisted general search', () => {
  it('appends configured text to the legacy planner and leaves its original system message unchanged when blank', async () => {
    const f = fixture();
    await f.service.search({ query: 'find something' });
    const original = (f.llm.json.mock.calls[0]![0] as unknown as { system: string }).system;
    expect(original).toContain('Stage 1: interpret the user\'s media request');
    expect(original).toContain('read-only retrieval and relevance work');
    expect(original).not.toContain('User-configured system instructions:');
    f.settings.ai.searchSystemPrompt = 'My exact line\n  with spacing';
    f.state.saveSettings(f.settings);
    const reloaded = f.state.getSettings();
    const rebuilt = new GeneralSearchService({ llm: f.llm as never, prowlarr: f.prowlarr as never, state: f.state, getSettings: () => f.state.getSettings(), runtimeSettings: reloaded });
    await rebuilt.search({ query: 'find something else' });
    const prompted = (f.llm.json.mock.calls.at(-1)![0] as unknown as { system: string }).system;
    expect(prompted).toBe(`${original}\n\nUser-configured system instructions:\nMy exact line\n  with spacing`);
  });
  it('surfaces a typed provider refusal without searching Prowlarr', async () => {
    const f = fixture();
    f.llm.json.mockRejectedValueOnce(Object.assign(new Error('provider-refusal'), { code: 'provider-refusal' }));
    await expect(f.service.search({ query: 'find a film' })).rejects.toMatchObject({ code: 'provider-refusal' });
    expect(f.prowlarr.search).not.toHaveBeenCalled();
  });
  it('maps a provider ApiError to a safe search-only code while retaining the shared client contract',async()=>{const f=fixture();f.llm.json.mockRejectedValueOnce(new ApiError(429,'https://provider.invalid/?key=secret','private body',120));await expect(f.service.search({query:'sports games'})).rejects.toMatchObject({code:'llm-provider-failure'});expect(f.prowlarr.search).not.toHaveBeenCalled();});
  it('preserves a mocked unique title and year through the legacy string query API', async () => {
    const f = fixture();
    const query = 'Spider-Man 2 (2004), the film';
    const exact = { ...planned(query), searchSpace: { focus: 'unique-title', identityAnchors: ['Spider-Man 2 (2004)'], medium: { value: 'film', provenance: 'explicit' }, positives: [], negatives: [], expansionScope: 'identity-preserving' }, proposals: [{ query, purpose: 'Find the named film', branch: 'title', strategy: 'identity-preserving', preserves: ['Spider Man 2 (2004)'] }] };
    f.llm.json.mockResolvedValueOnce(exact as never);
    const result = await f.service.search({ query });
    expect(f.prowlarr.search).toHaveBeenCalledWith({ query, categories: [] });
    expect(result.queries).toEqual([query]);
  });
  it('repairs legacy plans with original planning context and omits rejected raw output', async () => {
    const f=fixture();const bad=planned('https://private.invalid/query?token=private-secret');f.llm.json.mockReset();f.llm.json.mockResolvedValueOnce(bad as never).mockResolvedValueOnce(planned('sports games') as never);f.prowlarr.search.mockResolvedValue([]);
    await f.service.search({query:'sports games'});
    const repair=JSON.parse(f.llm.json.mock.calls[1]![0].user!) as Record<string,any>;
    expect(repair).toMatchObject({role:'interpreter and initial query planner',request:'sports games',retrieval:{previousQueries:[],budget:6},correction:{failureCodes:['invalid-search-plan']}});
    expect(repair).not.toHaveProperty('invalidOutput');expect(JSON.stringify(f.llm.json.mock.calls)).not.toContain('private.invalid');expect(JSON.stringify(f.llm.json.mock.calls)).not.toContain('private-secret');
  });
  it('repairs unsafe text in every legacy interpretation field without echoing it into prompts or public output',async()=>{
    const fields=['query','purpose','branch','preserves','question','identity','alternative','reference','medium','positive','negative'] as const;
    for(const field of fields){const f=fixture();const bad=structuredClone(planned('safe query')) as any;const marker=`https://unsafe-${field}.invalid/path`;
      if(field==='query')bad.proposals[0].query=marker;
      else if(field==='purpose')bad.proposals[0].purpose=marker;
      else if(field==='branch')bad.proposals[0].branch=marker;
      else if(field==='preserves')bad.proposals[0].preserves=[marker];
      else if(field==='question'){bad.mode='clarify';bad.proposals=[];bad.question=marker;}
      else if(field==='identity')bad.searchSpace.identityAnchors=[marker];
      else if(field==='alternative')bad.searchSpace.alternativeAnchors=[marker];
      else if(field==='reference')bad.searchSpace.referenceEntities=[marker];
      else if(field==='medium')bad.searchSpace.medium={value:marker,provenance:'explicit'};
      else if(field==='positive')bad.searchSpace.positives=[{text:marker,strength:'soft'}];
      else bad.searchSpace.negatives=[{text:marker,strength:'hard'}];
      f.llm.json.mockReset();f.llm.json.mockResolvedValueOnce(bad).mockResolvedValueOnce(planned('safe query') as never);f.prowlarr.search.mockResolvedValue([]);
      const response=await f.service.search({query:'test'});const repair=JSON.parse(f.llm.json.mock.calls[1]![0].user!) as Record<string,unknown>;
      expect(repair).toMatchObject({correction:{failureCodes:['invalid-search-plan']}});expect(JSON.stringify(repair)).not.toContain(marker);expect(JSON.stringify(response)).not.toContain(marker);expect(f.prowlarr.search.mock.calls.map(([arg])=>arg.query)).toEqual(['safe query']);
    }
  });
  it('fails closed when repaired legacy interpretation repeats an unsafe search-space reference',async()=>{
    for(const field of ['identityAnchors','alternativeAnchors','referenceEntities','medium','positives','negatives'] as const){const f=fixture();const bad=structuredClone(planned('safe query')) as any;const marker='user:password@unsafe.invalid/key';
      if(field==='medium')bad.searchSpace.medium={value:marker,provenance:'explicit'};else if(field==='positives'||field==='negatives')bad.searchSpace[field]=[{text:marker,strength:'hard'}];else bad.searchSpace[field]=[marker];
      f.llm.json.mockReset().mockResolvedValue(bad as never);await expect(f.service.search({query:'test'})).rejects.toMatchObject({code:'invalid-search-plan'});expect(f.llm.json).toHaveBeenCalledTimes(2);expect(f.prowlarr.search).not.toHaveBeenCalled();expect(f.state.getGeneralSearchSnapshot('missing')).toBeNull();expect(JSON.stringify(f.llm.json.mock.calls[1]![0].user)).not.toContain(marker);
    }
  });
  it('charges legacy transport attempts and service repair against the same AI budget', async () => {
    for(const calls of [1,2]){const f=fixture();f.settings.generalSearch!.maxAiCalls=calls;f.state.saveSettings(f.settings);f.service=new GeneralSearchService({llm:f.llm as never,prowlarr:f.prowlarr as never,state:f.state,runtimeSettings:f.state.getSettings(),getSettings:()=>f.state.getSettings()});f.llm.json=vi.fn(async(args:{onAttempt?:(attempt:{logicalAttempt:number;transportAttempt:number})=>void})=>{args.onAttempt?.({logicalAttempt:0,transportAttempt:0});if(calls===2)args.onAttempt?.({logicalAttempt:0,transportAttempt:1});return planned('bad\nquery');}) as never;await expect(f.service.search({query:'sports games'})).rejects.toMatchObject({code:'ai-budget-exhausted'});expect(f.llm.json).toHaveBeenCalledTimes(1);expect(f.prowlarr.search).not.toHaveBeenCalled();}
  });
  it('does not issue a legacy repair after settings identity changes during the first model call', async () => {
    const f=fixture();f.llm.json=vi.fn(async()=>{f.settings.ai.model='rotated-model';f.state.saveSettings(f.settings);return planned('bad\nquery');}) as never;await expect(f.service.search({query:'sports games'})).rejects.toMatchObject({code:'settings-changed'});expect(f.llm.json).toHaveBeenCalledTimes(1);expect(f.prowlarr.search).not.toHaveBeenCalled();
  });
  it('rejects a clarification that becomes empty after URL redaction', async () => {
    const f=fixture();f.settings.generalSearch!.maxAiCalls=2;f.state.saveSettings(f.settings);f.service=new GeneralSearchService({llm:f.llm as never,prowlarr:f.prowlarr as never,state:f.state,runtimeSettings:f.state.getSettings(),getSettings:()=>f.state.getSettings()});const clarify={mode:'clarify',question:'https://private.invalid/path',searchSpace:{focus:'mixed',identityAnchors:[],medium:{value:null,provenance:'unknown'},positives:[],negatives:[],expansionScope:'identity-preserving'},proposals:[]};f.llm.json.mockReset();f.llm.json.mockResolvedValue(clarify as never);await expect(f.service.search({query:'sports games'})).rejects.toMatchObject({code:'invalid-search-plan'});expect(f.llm.json).toHaveBeenCalledTimes(2);expect(f.prowlarr.search).not.toHaveBeenCalled();
  });
  it('plans bounded queries, searches all categories, deduplicates and never submits during search', async () => {
    const f = fixture();
    const result = await f.service.search({ query: '  a general query private-api-key https://private.test/secret  ' });
    expect(result).toMatchObject({ status: 'selection-required', queries: ['query one', 'query two'] });
    expect(JSON.stringify(result)).not.toContain('private-api-key');
    expect(f.llm.json).toHaveBeenCalledWith(expect.objectContaining({ user: expect.not.stringContaining('private-api-key') }));
    expect(f.llm.json).toHaveBeenCalledTimes(1);
    expect(f.prowlarr.search).toHaveBeenCalledWith({ query: 'query one', categories: [] });
    expect(result.releases).toHaveLength(2);
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    const saved = JSON.stringify(f.state.getGeneralSearchSnapshot(result.searchId!)?.payload);
    expect(saved).not.toContain('private.test'); expect(saved).not.toContain('magnet:'); expect(saved).not.toContain('private-hash');
    expect(JSON.stringify(result)).not.toContain('private-guid');
    expect(JSON.stringify(result)).not.toContain('routingDigest');
    f.state.close();
  });

  it('fails before upstream work when the composed runtime settings are stale', async () => {
    const f = fixture();
    const runtimeSettings = structuredClone(f.state.getSettings());
    const service = new GeneralSearchService({ llm: f.llm as never, prowlarr: f.prowlarr as never, state: f.state, runtimeSettings, getSettings: () => f.state.getSettings() });
    f.settings.integrations.prowlarr.url = 'http://prowlarr-b.test';
    f.state.saveSettings(f.settings);
    await expect(service.search({ query: 'anything' })).rejects.toMatchObject({ code: 'settings-changed' });
    expect(f.llm.json).not.toHaveBeenCalled();
    expect(f.prowlarr.search).not.toHaveBeenCalled();
    expect(f.prowlarr.getDownloadClients).not.toHaveBeenCalled();
    f.state.close();
  });

  it('rejects an AI runtime mismatch before calling the planner', async () => {
    const f = fixture();
    const runtimeSettings = structuredClone(f.state.getSettings());
    const service = new GeneralSearchService({ llm: f.llm as never, prowlarr: f.prowlarr as never, state: f.state, runtimeSettings, getSettings: () => f.state.getSettings() });
    f.settings.ai.model = 'different-model';
    f.state.saveSettings(f.settings);
    await expect(service.search({ query: 'anything' })).rejects.toMatchObject({ code: 'settings-changed' });
    expect(f.llm.json).not.toHaveBeenCalled();
    f.state.close();
  });

  it('preserves sanitized requested query characters through the 500-character limit', async () => {
    const f = fixture();
    const query = `${'q'.repeat(440)}TAIL-UNTRUNCATED`;
    const result = await f.service.search({ query });
    expect(JSON.parse(f.llm.json.mock.calls[0]![0].user!).request).toBe(query);
    expect(result.query).toBe(query);
    f.state.close();
  });

  it('rejects a blank AI base URL before planner or Prowlarr work', async () => {
    const f = fixture();
    const runtimeSettings = structuredClone(f.state.getSettings());
    runtimeSettings.ai.baseUrl = '   ';
    const service = new GeneralSearchService({ llm: f.llm as never, prowlarr: f.prowlarr as never, state: f.state, runtimeSettings, getSettings: () => runtimeSettings });
    await expect(service.search({ query: 'anything' })).rejects.toMatchObject({ code: 'search-unavailable' });
    expect(f.llm.json).not.toHaveBeenCalled();
    expect(f.prowlarr.search).not.toHaveBeenCalled();
    expect(f.prowlarr.getDownloadClients).not.toHaveBeenCalled();
    f.state.close();
  });

  it('does not perform a destination lookup or POST from a stale captured Prowlarr runtime', async () => {
    const f = fixture();
    const runtimeSettings = structuredClone(f.state.getSettings());
    const service = new GeneralSearchService({ llm: f.llm as never, prowlarr: f.prowlarr as never, state: f.state, runtimeSettings, getSettings: () => f.state.getSettings() });
    const result = await service.search({ query: 'anything' });
    const lookupCount = f.prowlarr.getDownloadClients.mock.calls.length;
    f.settings.integrations.prowlarr.url = 'http://prowlarr-b.test';
    f.state.saveSettings(f.settings);
    await expect(service.grab(result.searchId!, { confirmationToken: result.confirmationToken!, releaseIds: [result.releases[0]!.releaseId], confirmed: true })).rejects.toMatchObject({ code: 'settings-changed' });
    expect(f.prowlarr.getDownloadClients).toHaveBeenCalledTimes(lookupCount);
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    f.state.close();
  });

  it('selects and submits with a real parsed client whose optional provider values are omitted', async () => {
    const f = fixture();
    const parsed = downloadClientSchema.parse({
      id: 41, name: 'General', enable: true, protocol: 'torrent', supportsCategories: true,
      categories: [{ clientCategory: 'general', categories: [2000] }],
      implementation: 'QBittorrent', configContract: 'QBittorrentSettings',
      fields: [{ name: 'host', value: 'qbit-a' }, { name: 'port', value: 8080 }, { name: 'urlBase' }, { name: 'apiKey' }],
    });
    f.prowlarr.getDownloadClients.mockResolvedValue([parsed] as never);
    const search = await f.service.search({ query: 'anything' });
    expect(search.releases[0]!.selectable).toBe(true);
    await f.service.grab(search.searchId!, { confirmationToken: search.confirmationToken!, releaseIds: [search.releases[0]!.releaseId], confirmed: true });
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledWith({ guid: 'same', indexerId: 8 }, 41);
    f.state.close();
  });

  it('redacts all configured API keys and arbitrary URI schemes before truncation in user, LLM, and upstream text', async () => {
    const f = fixture();
    f.settings.integrations.sonarr.apiKey = 'sonarr-secret-key';
    f.settings.integrations.radarr.apiKey = 'radarr-secret-key';
    f.settings.integrations.prowlarr.generalClient = 'General sonarr-secret-key';
    f.client.name = f.settings.integrations.prowlarr.generalClient;
    f.state.saveSettings(f.settings);
    f.service = new GeneralSearchService({ llm: f.llm as never, prowlarr: f.prowlarr as never, state: f.state, runtimeSettings: f.state.getSettings(), getSettings: () => f.state.getSettings() });
    f.llm.json.mockResolvedValueOnce({ ...planned('title radarr-secret-key ftp://user:pass@host/private'), proposals: [{ query: 'title radarr-secret-key ftp://user:pass@host/private', purpose: 'Search', branch: 'title', strategy: 'subcategory', preserves: [] }] });
    f.prowlarr.search.mockImplementation(async () => [release({ title: `${'x'.repeat(295)}radarr-secret-key ftp://user:ftp-secret@host/private`, indexer: 'https://sonarr-secret-key@private.test' })]);
    const input = `${'q'.repeat(275)}radarr-secret-key ftp://user:password@host/private sonarr-secret-key`;
    const response = await f.service.search({ query: input });
    const serialized = JSON.stringify(response);
    for (const secret of ['private-api-key', 'private-llm-key', 'sonarr-secret-key', 'radarr-secret-key', 'ftp-secret', 'password@host']) {
      expect(serialized).not.toContain(secret);
      expect(JSON.stringify(f.llm.json.mock.calls[0]?.[0])).not.toContain(secret);
    }
    expect(serialized).not.toContain('private.test');
    f.state.close();
  });

  it('excludes credential-bearing release references before snapshot persistence', async () => {
    const f = fixture();
    f.prowlarr.search.mockResolvedValue([release({ guid: 'https://private-user:private-password@host/release?apiKey=secret' }), release({ guid: 'safe-guid' })]);
    const response = await f.service.search({ query: 'safe request' });
    expect(response.releases).toHaveLength(1);
    const snapshot = JSON.stringify(f.state.getGeneralSearchSnapshot(response.searchId!)?.payload);
    expect(snapshot).not.toContain('private-user');
    expect(snapshot).not.toContain('private-password');
    expect(snapshot).not.toContain('apiKey=secret');
    f.state.close();
  });

  it('redacts destination names in snapshots and operation status while matching the private identity digest', async () => {
    const f = fixture();
    f.settings.integrations.prowlarr.generalClient = 'private-api-key';
    f.client.name = 'private-api-key'; f.state.saveSettings(f.settings);
    f.service = new GeneralSearchService({ llm: f.llm as never, prowlarr: f.prowlarr as never, state: f.state, runtimeSettings: f.state.getSettings(), getSettings: () => f.state.getSettings() });
    const result = await f.service.search({ query: 'safe title' });
    const snapshot = f.state.getGeneralSearchSnapshot(result.searchId!)!;
    expect(JSON.stringify(snapshot)).not.toContain('private-api-key');
    expect(result.destination?.name).not.toContain('private-api-key');
    const operation = await f.service.createOperation(result.searchId!, { operationId: randomUUID(), confirmationToken: result.confirmationToken!, releaseIds: [result.releases[0]!.releaseId], confirmed: true });
    expect(JSON.stringify(operation)).not.toContain('private-api-key');
    expect((await f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken!, releaseIds: [result.releases[1]!.releaseId], confirmed: true })).results[0]?.status).toBe('submitted');
    f.state.close();
  });

  it('does not persist a search snapshot if source or AI settings drift during upstream search', async () => {
    for (const drift of ['source', 'ai'] as const) {
      const f = fixture();
      let resolveSearch!: (releases: Release[]) => void;
      f.prowlarr.search.mockImplementationOnce(() => new Promise((resolve) => { resolveSearch = resolve; }));
      const pending = f.service.search({ query: 'anything' });
      while (!resolveSearch) await Promise.resolve();
      const settings = f.state.getSettings();
      if (drift === 'source') settings.integrations.prowlarr.apiKey = 'rotated-during-search';
      else settings.ai.model = 'changed-during-search';
      f.state.saveSettings(settings);
      resolveSearch([release()]);
      await expect(pending).rejects.toMatchObject({ code: 'settings-changed' });
      const db = (f.state as unknown as { db: import('better-sqlite3').Database }).db;
      expect((db.prepare('SELECT COUNT(*) AS count FROM general_search_snapshots').get() as { count: number }).count).toBe(0);
      f.state.close();
    }
  });

  it('submits only the explicitly selected cached release to the exact configured client; duplicate confirmation is idempotent', async () => {
    const f = fixture(); const search = await f.service.search({ query: 'anything' });
    const chosen = search.releases[0]!;
    const input = { confirmationToken: search.confirmationToken!, releaseIds: [chosen.releaseId], confirmed: true as const };
    const first = await f.service.grab(search.searchId!, input);
    expect(first.results).toEqual([{ releaseId: chosen.releaseId, status: 'submitted', code: null }]);
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledWith({ guid: 'same', indexerId: 8 }, 41);
    expect(await f.service.grab(search.searchId!, input)).toMatchObject({ results: [{ status: 'submitted' }] });
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    const newSearch = await f.service.search({ query: 'anything again' });
    expect(await f.service.grab(newSearch.searchId!, { confirmationToken: newSearch.confirmationToken!, releaseIds: [newSearch.releases[0]!.releaseId], confirmed: true })).toMatchObject({ results: [{ status: 'submitted' }] });
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it.each(['submitted', 'uncertain'] as const)('keeps %s receipts protected across Prowlarr API-key rotation', async (previousStatus) => {
    const f = fixture();
    const original = await f.service.search({ query: 'anything' });
    const chosenId = original.releases[0]!.releaseId;
    if (previousStatus === 'uncertain') f.prowlarr.grabGeneral.mockRejectedValueOnce({ status: 0 });
    const first = await f.service.grab(original.searchId!, { confirmationToken: original.confirmationToken!, releaseIds: [chosenId], confirmed: true });
    expect(first.results[0]?.status).toBe(previousStatus);
    f.settings.integrations.prowlarr.apiKey = 'rotated-prowlarr-key';
    f.state.saveSettings(f.settings);
    f.service = new GeneralSearchService({ llm: f.llm as never, prowlarr: f.prowlarr as never, state: f.state, runtimeSettings: f.state.getSettings(), getSettings: () => f.state.getSettings() });
    const afterRotation = await f.service.search({ query: 'anything again' });
    const retry = await f.service.grab(afterRotation.searchId!, { confirmationToken: afterRotation.confirmationToken!, releaseIds: [afterRotation.releases[0]!.releaseId], confirmed: true });
    expect(retry.results[0]?.status).toBe(previousStatus);
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('allows a frozen no-LLM grab after AI-only settings drift', async () => {
    const f = fixture(); const search = await f.service.search({ query: 'anything' });
    f.settings.ai.model = 'updated-model-without-changing-source'; f.state.saveSettings(f.settings);
    const result = await f.service.grab(search.searchId!, { confirmationToken: search.confirmationToken!, releaseIds: [search.releases[0]!.releaseId], confirmed: true });
    expect(result.results[0]?.status).toBe('submitted');
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('serializes concurrent submissions and preserves completed receipts across restart', async () => {
    const f = fixture(); const search = await f.service.search({ query: 'anything' });
    const releaseId = search.releases[0]!.releaseId;
    const body = { confirmationToken: search.confirmationToken!, releaseIds: [releaseId], confirmed: true as const };
    const [a, b] = await Promise.all([f.service.grab(search.searchId!, body), f.service.grab(search.searchId!, body)]);
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    expect([a.results[0]?.status, b.results[0]?.status].sort()).toEqual(['submitted', 'submitting']);
    f.state.close();

    const dir = mkdtempSync(join(tmpdir(), 'general-search-receipt-')); const path = join(dir, 'state.sqlite');
    try {
      const state = State.open(path);
      state.saveGeneralSearchSnapshot({ id: 'search', tokenDigest: 'digest', expiresAt: '2030-01-01T00:00:00.000Z', fingerprint: 'fp', clientName: 'client', clientProtocol: 'torrent', clientId: 1, routingDigest: 'routing', dryRun: false, payload: { releases: [] } });
      expect(state.reserveGeneralSearchRelease('search', 'release', '2026-10-06T00:00:00.000Z', 'pending-key').reserved).toBe(true);
      const independent = State.open(path);
      expect(independent.reserveGeneralSearchRelease('search-2', 'release-2', '2026-10-06T00:00:00.000Z', 'pending-key')).toMatchObject({ reserved: false, status: 'submitting' });
      const contenders = await Promise.all([
        Promise.resolve().then(() => state.reserveGeneralSearchRelease('race-a', 'release-a', '2026-10-06T00:00:00.000Z', 'race-key')),
        Promise.resolve().then(() => independent.reserveGeneralSearchRelease('race-b', 'release-b', '2026-10-06T00:00:00.000Z', 'race-key')),
      ]);
      expect(contenders.filter(({ reserved }) => reserved)).toHaveLength(1);
      independent.close(); state.close();
      const restored = State.open(path);
      expect(restored.reserveGeneralSearchRelease('search', 'release', '2026-10-06T00:01:00.000Z', 'pending-key')).toMatchObject({ reserved: false, status: 'submitting' });
      restored.finishGeneralSearchRelease('search', 'release', 'submitted', null, '2026-10-06T00:02:00.000Z');
      expect(restored.reserveGeneralSearchRelease('search-2', 'release-2', '2026-10-06T00:03:00.000Z', 'pending-key')).toMatchObject({ reserved: false, status: 'submitted' });
      restored.close();

      const legacy = State.open(path);
      expect(legacy.reserveGeneralSearchRelease('old-search', 'legacy-release', '2026-10-06T00:04:00.000Z', 'old-api-key-hash').reserved).toBe(true);
      legacy.finishGeneralSearchRelease('old-search', 'legacy-release', 'uncertain', 'upstream-uncertain', '2026-10-06T00:04:01.000Z');
      legacy.migrateLegacyGeneralSearchReceipt('stable-key', 'old-api-key-hash');
      expect(legacy.reserveGeneralSearchRelease('new-search', 'new-release', '2026-10-06T00:05:00.000Z', 'stable-key', 'old-api-key-hash')).toMatchObject({ reserved: false, status: 'uncertain' });
      legacy.close();
      restored.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['submitted', 'uncertain', 'submitting'] as const)('does not migrate source A %s receipt onto source B identity', (status) => {
    const state = State.open(':memory:');
    expect(state.reserveGeneralSearchRelease('search-a', 'release-a', '2026-10-06T00:00:00.000Z', 'source-a-stable').reserved).toBe(true);
    if (status !== 'submitting') state.finishGeneralSearchRelease('search-a', 'release-a', status, status === 'uncertain' ? 'upstream-uncertain' : null, '2026-10-06T00:00:01.000Z');
    state.migrateLegacyGeneralSearchReceipt('source-b-stable', 'source-b-legacy');
    expect(state.reserveGeneralSearchRelease('search-b', 'release-b', '2026-10-06T00:00:02.000Z', 'source-b-stable', 'source-b-legacy')).toMatchObject({ reserved: true, status: 'submitting' });
    expect(state.reserveGeneralSearchRelease('search-a-retry', 'release-a-retry', '2026-10-06T00:00:03.000Z', 'source-a-stable')).toMatchObject({ reserved: false, status });
    state.close();
  });

  it('dry-run and disabled operator actions never POST; does not call Arr services', async () => {
    const f = fixture({ dryRun: true }); const result = await f.service.search({ query: 'anything' });
    const response = await f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken!, releaseIds: [result.releases[0]!.releaseId], confirmed: true });
    expect(response.results[0]?.status).toBe('dry-run'); expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    expect(f.prowlarr.getDownloadClients).toHaveBeenCalled();
    f.state.saveSettings({ ...f.settings, safety: { ...f.settings.safety, dryRun: false, allowOperatorActions: false } });
    await expect(f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken!, releaseIds: [result.releases[0]!.releaseId], confirmed: true })).rejects.toMatchObject({ code: 'operator-actions-disabled' });
    f.state.close();
  });

  it('does not treat a dry-run step as a source submission receipt', async () => {
    const f = fixture({ dryRun: true }); const preview = await f.service.search({ query: 'anything' });
    const releaseId = preview.releases[0]!.releaseId;
    expect((await f.service.grab(preview.searchId!, { confirmationToken: preview.confirmationToken!, releaseIds: [releaseId], confirmed: true })).results[0]?.status).toBe('dry-run');
    f.settings.safety.dryRun = false; f.state.saveSettings(f.settings);
    f.service = new GeneralSearchService({ llm: f.llm as never, prowlarr: f.prowlarr as never, state: f.state, runtimeSettings: f.state.getSettings(), getSettings: () => f.state.getSettings() });
    const live = await f.service.search({ query: 'same source and release' });
    expect((await f.service.grab(live.searchId!, { confirmationToken: live.confirmationToken!, releaseIds: [live.releases[0]!.releaseId], confirmed: true })).results[0]?.status).toBe('submitted');
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('reports disabled operator actions specifically and rejects disabled, ambiguous, or protocol-mismatched destinations', async () => {
    const denied = fixture({ allow: false });
    const deniedResult = await denied.service.search({ query: 'anything' });
    expect(deniedResult.blockedReason).toBe('operator-actions-disabled');
    denied.state.close();

    for (const clients of [
      [{ ...fixtureClient(), enable: false }],
      [fixtureClient(), { ...fixtureClient(), id: 42 }],
      [{ ...fixtureClient(), protocol: 'unknown' as const }],
      [{ ...fixtureClient(), protocol: 'usenet' as const }],
      [{ ...fixtureClient(), routingDigest: null as never }],
    ]) {
      const f = fixture(); f.prowlarr.getDownloadClients.mockResolvedValue(clients as never);
      const result = await f.service.search({ query: 'anything' });
      expect(result.releases.every((release) => !release.selectable)).toBe(true);
      expect(result.blockedReason).not.toBeNull();
      f.state.close();
    }
  });

  it('retains an outstanding durable hold when operation persistence fails after an accepted submission', async () => {
    const f = fixture(); const result = await f.service.search({ query: 'anything' });
    const finish = vi.spyOn(f.state, 'finishGeneralSearchOperationStep').mockImplementationOnce(() => { throw new Error('persistence unavailable'); });
    const body = { confirmationToken: result.confirmationToken!, releaseIds: [result.releases[0]!.releaseId], confirmed: true as const };
    await expect(f.service.grab(result.searchId!, body)).rejects.toThrow('persistence unavailable');
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    const retry = await f.service.grab(result.searchId!, body);
    expect(retry.results[0]?.status).toBe('submitting');
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('leaves a durable submitting hold when receipt persistence remains unavailable after POST', async () => {
    const f = fixture(); const result = await f.service.search({ query: 'anything' });
    vi.spyOn(f.state, 'finishGeneralSearchOperationStep').mockImplementation(() => { throw new Error('persistence unavailable'); });
    const body = { confirmationToken: result.confirmationToken!, releaseIds: [result.releases[0]!.releaseId], confirmed: true as const };
    await expect(f.service.grab(result.searchId!, body)).rejects.toThrow();
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    const retry = await f.service.grab(result.searchId!, body);
    expect(retry.results[0]?.status).toBe('submitting');
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('rejects malformed and unknown selected release IDs without a grab', async () => {
    const f = fixture(); const result = await f.service.search({ query: 'anything' });
    await expect(f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken, releaseIds: ['not-in-snapshot'], confirmed: true })).rejects.toMatchObject({ code: 'invalid-release-selection' });
    f.state.close();
  });

  it('accepts a frozen manifest above ten and rejects changed client category routing', async () => {
    const f = fixture();
    f.prowlarr.search.mockImplementation(async () => Array.from({ length: 12 }, (_, i) => release({ guid: `manifest-${i}` })));
    const result = await f.service.search({ query: 'anything' });
    const many = result.releases.slice(0, 11).map(({ releaseId }) => releaseId);
    const accepted = await f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken, releaseIds: many, confirmed: true });
    expect(accepted.results).toHaveLength(11);
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(11);
    f.client.categories = [{ clientCategory: 'general', categories: [2000] }]; f.client.routingDigest = 'b'.repeat(64);
    await expect(f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken, releaseIds: [result.releases[0]!.releaseId], confirmed: true })).rejects.toMatchObject({ code: 'destination-changed' });
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(11);
    f.state.close();
  });

  it('persists only a routing digest and never exposes provider configuration or its digest publicly', async () => {
    const f = fixture();
    const parsed = downloadClientSchema.parse({
      id: 41, name: 'General', enable: true, protocol: 'torrent', supportsCategories: true,
      categories: [{ clientCategory: 'general', categories: [2000] }], implementation: 'QBittorrent', configContract: 'QBittorrentSettings',
      fields: [{ name: 'Host', value: 'qbit-private-host' }, { name: 'Password', value: 'provider-password-secret' }],
    });
    f.prowlarr.getDownloadClients.mockResolvedValue([parsed] as never);
    const response = await f.service.search({ query: 'private documentary' });
    const snapshot = f.state.getGeneralSearchSnapshot(response.searchId!)!;
    expect(snapshot.routingDigest).toBe(parsed.routingDigest);
    expect(JSON.stringify(snapshot)).not.toContain('provider-password-secret');
    expect(JSON.stringify(snapshot)).not.toContain('qbit-private-host');
    expect(JSON.stringify(response)).not.toContain(parsed.routingDigest);
    expect(JSON.stringify(response)).not.toContain('provider-password-secret');
    expect(JSON.stringify(response)).not.toContain('qbit-private-host');
    f.state.close();
  });

  it('rejects a changed provider host with the same client identity and protocol', async () => {
    const f = fixture();
    const providerClient = (host: string) => downloadClientSchema.parse({
      id: 41, name: 'General', enable: true, protocol: 'torrent', supportsCategories: true,
      categories: [{ clientCategory: 'general', categories: [2000] }], implementation: 'QBittorrent', configContract: 'QBittorrentSettings',
      fields: [{ name: 'Host', value: host }, { name: 'Port', value: 8080 }, { name: 'Password', value: 'private-password' }],
    });
    f.prowlarr.getDownloadClients.mockResolvedValueOnce([providerClient('qbit-a')] as never);
    const search = await f.service.search({ query: 'anything' });
    f.prowlarr.getDownloadClients.mockResolvedValueOnce([providerClient('qbit-b')] as never);
    await expect(f.service.grab(search.searchId!, { confirmationToken: search.confirmationToken!, releaseIds: [search.releases[0]!.releaseId], confirmed: true })).rejects.toMatchObject({ code: 'destination-changed' });
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    f.state.close();
  });

  it.each([
    ['network', { status: 0 }], ['server', { status: 503 }], ['invalid-success', { status: 200 }], ['invalid-response', {}],
  ])('holds an %s outcome and never retries it automatically', async (_label, failure) => {
    const f = fixture(); const result = await f.service.search({ query: 'anything' });
    f.prowlarr.grabGeneral.mockRejectedValueOnce(failure);
    const body = { confirmationToken: result.confirmationToken!, releaseIds: [result.releases[0]!.releaseId], confirmed: true as const };
    const first = await f.service.grab(result.searchId!, body);
    expect(first.results[0]?.status).toBe('uncertain');
    const retry = await f.service.grab(result.searchId!, body);
    expect(retry.results[0]?.status).toBe('uncertain');
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('stops a multi-release batch after a client rejection', async () => {
    const f = fixture(); const result = await f.service.search({ query: 'anything' });
    f.prowlarr.grabGeneral.mockRejectedValueOnce({ status: 429 });
    const response = await f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken!, releaseIds: result.releases.map(({ releaseId }) => releaseId), confirmed: true });
    expect(response.results.map(({ status, code }) => [status, code])).toEqual([['failed', 'upstream-429'], ['not-attempted', 'upstream-429']]);
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('rechecks expiry and safety settings after a delayed destination lookup', async () => {
    const f = fixture(); const result = await f.service.search({ query: 'anything' });
    let releaseLookup!: (value: Array<typeof f.client>) => void;
    f.prowlarr.getDownloadClients.mockImplementationOnce(() => new Promise((resolve) => { releaseLookup = resolve; }));
    const pending = f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken!, releaseIds: [result.releases[0]!.releaseId], confirmed: true });
    await vi.waitFor(() => expect(releaseLookup).toBeTypeOf('function'));
    f.state.saveSettings({ ...f.settings, safety: { ...f.settings.safety, allowOperatorActions: false } });
    releaseLookup([f.client]);
    await expect(pending).rejects.toMatchObject({ code: 'operator-actions-disabled' });
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    f.state.close();
  });

  it('blocks dry-run mode changes made while destination resolution is pending', async () => {
    const f = fixture(); const result = await f.service.search({ query: 'anything' });
    let releaseLookup!: (value: Array<typeof f.client>) => void;
    f.prowlarr.getDownloadClients.mockImplementationOnce(() => new Promise((resolve) => { releaseLookup = resolve; }));
    const pending = f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken!, releaseIds: [result.releases[0]!.releaseId], confirmed: true });
    await vi.waitFor(() => expect(releaseLookup).toBeTypeOf('function'));
    f.state.saveSettings({ ...f.settings, safety: { ...f.settings.safety, dryRun: true } });
    releaseLookup([f.client]);
    await expect(pending).rejects.toMatchObject({ code: 'settings-changed' });
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    f.state.close();
  });

  it('rechecks result expiry after delayed destination resolution', async () => {
    const f = fixture(); const result = await f.service.search({ query: 'anything' });
    let releaseLookup!: (value: Array<typeof f.client>) => void;
    f.prowlarr.getDownloadClients.mockImplementationOnce(() => new Promise((resolve) => { releaseLookup = resolve; }));
    const pending = f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken!, releaseIds: [result.releases[0]!.releaseId], confirmed: true });
    await vi.waitFor(() => expect(releaseLookup).toBeTypeOf('function'));
    f.advance(15 * 60_000 + 1);
    releaseLookup([f.client]);
    await expect(pending).rejects.toMatchObject({ code: 'search-expired' });
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    f.state.close();
  });

  it('stops unsent items when operator permission changes between batch releases', async () => {
    const f = fixture(); const result = await f.service.search({ query: 'anything' });
    f.prowlarr.grabGeneral.mockImplementationOnce(async () => { f.state.saveSettings({ ...f.settings, safety: { ...f.settings.safety, allowOperatorActions: false } }); });
    const response = await f.service.grab(result.searchId!, { confirmationToken: result.confirmationToken!, releaseIds: result.releases.map(({ releaseId }) => releaseId), confirmed: true });
    expect(response.results.map(({ status }) => status)).toEqual(['submitted', 'not-attempted']);
    expect(response.results[1]?.code).toBe('operator-actions-disabled');
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('rejects operation creation when settings change during manifest preflight', async () => {
    const f = fixture(); const result = await f.service.search({ query: 'anything' });
    const releaseId = result.releases[0]!.releaseId;
    const body = { confirmationToken: result.confirmationToken!, releaseIds: [releaseId], confirmed: true as const };
    const readSettings = f.state.getSettings.bind(f.state);
    let reads = 0;
    const settingsSpy = vi.spyOn(f.state, 'getSettings').mockImplementation(() => {
      reads++;
      const settings = readSettings();
      return reads === 4 ? { ...settings, safety: { ...settings.safety, allowOperatorActions: false } } : settings;
    });
    await expect(f.service.grab(result.searchId!, body)).rejects.toMatchObject({ code: 'operator-actions-disabled' });
    expect(f.prowlarr.grabGeneral).not.toHaveBeenCalled();
    settingsSpy.mockRestore();
    const retried = await f.service.grab(result.searchId!, body);
    expect(retried.results[0]?.status).toBe('submitted');
    expect(f.prowlarr.grabGeneral).toHaveBeenCalledTimes(1);
    f.state.close();
  });

  it('serves strict same-origin search and grab endpoints with safe error envelopes', async () => {
    const f = fixture();
    const stack = { state: f.state, logger: pino({ level: 'silent' }), generalSearch: f.service } as unknown as Stack;
    stack.createSnapshot = () => stack;
    const app = await buildApp(stack);
    try {
      expect((await app.inject({ method: 'POST', url: '/api/search', payload: { query: 'valid', extra: true } })).json()).toMatchObject({ code: 'invalid-request' });
      const search = await app.inject({ method: 'POST', url: '/api/search', payload: { query: 'valid' } });
      expect(search.statusCode).toBe(200);
      const body = search.json();
      const badToken = await app.inject({ method: 'POST', url: `/api/search/${body.searchId}/grab`, payload: { confirmationToken: 'x'.repeat(32), releaseIds: [body.releases[0].releaseId], confirmed: true } });
      expect(badToken.statusCode).toBe(400);
      expect(badToken.json()).toEqual({ error: 'general grab unavailable', code: 'invalid-confirmation' });
      const crossOrigin = await app.inject({ method: 'POST', url: '/api/search', headers: { origin: 'https://evil.test' }, payload: { query: 'valid' } });
      expect(crossOrigin.statusCode).toBe(403);
    } finally { await app.close(); f.state.close(); }
  });
});

function fixtureClient() { return { id: 41, name: 'General', enable: true, protocol: 'torrent' as const, supportsCategories: true, categories: [] as Array<{clientCategory: string | null; categories: number[] | null}>, routingDigest: 'a'.repeat(64) }; }
