import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildApp } from '../src/daemon';
import type { Stack } from '../src/compose';
import { SearchRuntime, type RuntimeClients } from '../src/search/runtime';
import { openSearchStore } from '../src/search/store';
import { defaultSettings } from '../src/search/settings';
import { releaseSchema } from '../src/types/prowlarr';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(clientOverride?: RuntimeClients) {
  let reads = 0, grabs = 0;
  const initialSettings = { ...defaultSettings, ai: { ...defaultSettings.ai, apiKey: 'private-model' }, integrations: { ...defaultSettings.integrations, prowlarr: { ...defaultSettings.integrations.prowlarr, url: 'http://indexer.test', apiKey: 'private-indexer' }, sonarr: { url: 'http://sonarr.test', apiKey: 'private-sonarr' }, radarr: { url: '', apiKey: '' } } };
  const runtime = new SearchRuntime({
    store: openSearchStore(':memory:'), initialSettings,
    clients: () => clientOverride ?? ({
      prowlarr: {
        getIndexers: async () => { reads++; return [{ id: 1, name: 'Index', enable: true }]; },
        getIndexerStatuses: async () => [], search: async () => [],
        getDownloadClients: async () => [{ id: 7, name: 'TV', protocol: 'torrent', enable: true, supportsCategories: true, categories: [] }],
        grab: async () => { grabs++; },
      },
    } as unknown as RuntimeClients),
  });
  const stack = { runtime, config: { HTTP_HOST: '127.0.0.1', HTTP_PORT: 7877, DB_PATH: ':memory:', LOG_LEVEL: 'silent' }, logger: pino({ level: 'silent' }) } as unknown as Stack;
  const app = await buildApp(stack, { webRoot: '/nonexistent-ui' });
  cleanups.push(async () => { await app.close(); await runtime.close(); });
  return { app, runtime, reads: () => reads, grabs: () => grabs };
}

describe('search-first HTTP contract', () => {
  it('accepts ordinary Arr episodes without absolute numbering', async () => {
    const { app, runtime } = await fixture({
      sonarr: {
        getSeries: async () => [{ id: 11, tvdbId: 110, title: 'Standard Show', titleSlug: 'standard-show', seriesType: 'standard', monitored: true, seasons: [], alternateTitles: [] }],
        getEpisodes: async () => [{ id: 111, seriesId: 11, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Episode', airDate: '2020-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile: false }],
        getQueue: async () => [],
      },
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      runtime.store.setProviderDeadline('model', Date.now() + 60_000);
      await runtime.poll();
      const id = runtime.automationStatus().items[0]!.targetId;
      const started = await runtime.startArrSearch(id);
      const intent = (await runtime.getSearch(started.searchId))!.normalizedRequest!.intents[0]!;
      expect(intent).toMatchObject({ season: 2, episode: 1 });
      expect(intent).not.toHaveProperty('absoluteEpisode');
    } finally { await app.close(); await runtime.close(); }
  });

  it('drains in-flight Arr preparation and refuses enqueue after quiesce', async () => {
    let block = false, release!: () => void, began!: () => void;
    const entered = new Promise<void>(resolve => { began = resolve; });
    const pendingRead = new Promise<void>(resolve => { release = resolve; });
    const { app, runtime } = await fixture({
      sonarr: {
        getSeries: async () => {
          if (block) { began(); await pendingRead; }
          return [{ id: 11, tvdbId: 110, title: 'Standard Show', titleSlug: 'standard-show', seriesType: 'standard', monitored: true, seasons: [], alternateTitles: [] }];
        },
        getEpisodes: async () => [{ id: 111, seriesId: 11, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 13, title: 'Episode', airDate: '2020-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile: false }],
        getQueue: async () => [],
      },
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      await runtime.poll();
      const id = runtime.automationStatus().items[0]!.targetId;
      block = true;
      const starting = runtime.startArrSearch(id).then(
        value => ({ value, error: undefined }),
        error => ({ value: undefined, error }),
      );
      await entered;
      runtime.quiesce();
      let drained = false;
      const draining = runtime.drain().then(() => { drained = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(drained).toBe(false);
      release();
      expect((await starting).error?.message).toBe('runtime-closed');
      await draining;
      expect(runtime.store.listSearches()).toHaveLength(0);
    } finally { release(); await app.close(); await runtime.close(); }
  });

  it('resolves explicit Arr refs fresh, enforces canonical scope, and leaves generic opaque targets unbound', async () => {
    let targetHasFile = false, targetQueued = false, episodeReads = 0;
    const series = [
      { id: 11, tvdbId: 110, title: 'Show One', titleSlug: 'show-one', seriesType: 'standard' as const, monitored: true, seasons: [], alternateTitles: [] },
      { id: 22, tvdbId: 220, title: 'Show Two', titleSlug: 'show-two', seriesType: 'anime' as const, monitored: true, seasons: [], alternateTitles: [] },
    ];
    const clients: RuntimeClients = {
      prowlarr: { getIndexers: async () => [], getIndexerStatuses: async () => [], search: async () => [] },
      sonarr: {
        getSeries: async () => series,
        getEpisodes: async id => {
          episodeReads++;
          const numbers = id === 11 ? [{ id: 111, episodeNumber: 2, absoluteEpisodeNumber: 26 }, { id: 112, episodeNumber: 3, absoluteEpisodeNumber: 27 }] : [{ id: 122, episodeNumber: 2, absoluteEpisodeNumber: 50 }];
          return numbers.map(number => ({ ...number, seriesId: id, seasonNumber: 1, title: 'Episode', airDate: '2020-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile: targetHasFile }));
        },
        getQueue: async () => targetQueued ? [{ seriesId: 11, episodeId: 111, status: 'downloading' }] : [],
      },
    };
    const { app, runtime } = await fixture(clients);
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      runtime.store.setProviderDeadline('model', Date.now() + 60_000);
      await runtime.poll();
      const ids = runtime.automationStatus().items.map(item => item.targetId);
      expect(ids).toHaveLength(3);
      await expect(runtime.startSearch({ prompt: 'Find', arrTargetIds: ['not-a-real-target'] })).rejects.toThrow('target-not-found');
      await expect(runtime.startSearch({ prompt: 'Find both', arrTargetIds: ids })).rejects.toThrow('arr-target-scope-conflict');
      const firstId = ids[0]!;
      await expect(runtime.startSearch({ prompt: 'Find conflict', arrTargetIds: [firstId], context: { kind: 'tv', externalIds: { tvdb: 999 } } })).rejects.toThrow('arr-target-context-conflict');
      await expect(runtime.startSearch({ prompt: 'Find conflict', arrTargetIds: [firstId], context: { kind: 'tv', scope: { type: 'episode', seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: 99 } } })).rejects.toThrow('arr-target-context-conflict');
      const readsBeforeArrSearch = episodeReads;
      const started = await runtime.startArrSearch(firstId);
      expect(episodeReads - readsBeforeArrSearch).toBe(2); // One fresh observation, not a preflight plus a second resolution.
      const persistedBindings = runtime.store.getSetting(`search-arr-bindings-v1:${started.searchId}`) as Array<{ key: string; serviceId: number }>;
      expect(persistedBindings).toHaveLength(1);
      expect(persistedBindings[0]).toMatchObject({ serviceId: 11 });
      expect(runtime.store.getSetting(`search-arr:${started.searchId}`)).toBeNull();
      expect(runtime.store.getSetting(`search-source:${started.searchId}`)).toBe('arr');
      const stored = await runtime.getSearch(started.searchId);
      expect(stored?.normalizedRequest).toMatchObject({
        kind: 'show', scope: 'episode', externalIds: { tvdb: 110 },
        intents: [{ season: 1, episode: 2, absoluteEpisode: 26 }],
      });
      const multi = await runtime.startSearch({ prompt: 'Find the two missing episodes', arrTargetIds: ids.slice(0, 2) });
      expect(runtime.store.getSetting(`search-arr-bindings-v1:${multi.searchId}`)).toHaveLength(2);
      expect((await runtime.getSearch(multi.searchId))?.normalizedRequest?.intents).toMatchObject([
        { season: 1, episode: 2, absoluteEpisode: 26 }, { season: 1, episode: 3, absoluteEpisode: 27 },
      ]);
      targetHasFile = true;
      await expect(runtime.startSearch({ prompt: 'No longer eligible', arrTargetIds: [firstId] })).rejects.toThrow('target-not-eligible');
      targetHasFile = false;
      targetQueued = true;
      await expect(runtime.startSearch({ prompt: 'Queued already', arrTargetIds: [firstId] })).rejects.toThrow('target-not-eligible');
      const generic = await runtime.startSearch({ prompt: 'Opaque generic', context: { kind: 'tv', scope: { type: 'episode-set' }, targets: [{ targetId: firstId, seasonNumber: 1, episodeNumber: 2 }] } });
      expect(runtime.store.getSetting(`search-arr-bindings-v1:${generic.searchId}`)).toBeNull();
      expect(runtime.store.getSetting(`search-source:${generic.searchId}`)).toBe('manual');
      expect((await runtime.getSearch(generic.searchId))?.normalizedRequest?.targetIds).toEqual([firstId]);
    } finally {
      await app.close();
      await runtime.close();
    }
  });
  it('contains no retired engine modules or operator CLI compatibility stub', () => {
    for (const path of [
      'core/runner.ts', 'core/state.ts', 'core/work-queue.ts', 'core/operations.ts', 'core/operator-actions.ts', 'operator-cli.ts',
      'search/service.ts', 'search/selection.ts', 'clients/llm.ts', '../scripts/evaluate-search.ts',
      '../scripts/evaluate-anime-search.ts', '../scripts/compare-anime-models.ts',
    ]) {
      expect(existsSync(new URL(`../src/${path}`, import.meta.url)), path).toBe(false);
    }
  });
  it('disables submission while retaining read-only Activity', async () => {
    const { app, runtime, grabs } = await fixture(), now = Date.now();
    runtime.store.createSearch({ searchId: 'match', prompt: '{"prompt":"Example"}', status: 'matched', createdAt: now, finishedAt: now, result: { options: [{ optionId: 'option', rank: 1, releases: [{ candidateId: 'candidate' }], coveredTargetIds: [], reason: 'Fit', uncertainty: '' }] } });
    runtime.store.addCandidate({ searchId: 'match', candidateId: 'candidate', safe: {}, privateData: { release: releaseSchema.parse({ guid: 'private', indexerId: 1, indexer: 'Index', title: 'Example', publishDate: '', protocol: 'torrent' }), physicalKey: 'private-key' }, expiresAt: now - 1 });
    const confirm = (key: string) => app.inject({ method: 'POST', url: '/api/v2/submissions', payload: { searchId: 'match', optionId: 'option', downloadClientId: 7, idempotencyKey: key } });
    expect((await confirm('expired')).statusCode).toBe(410);
    expect((await app.inject('/api/v2/activity?status=dry-run')).json()).toMatchObject({ total: 0 });
    expect(grabs()).toBe(0);
    const settings = runtime.getSettings();
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { ...settings, monitoring: { ...settings.monitoring, searchRetryMinutes: 1e15 } } })).statusCode).toBe(400);
  });
  it('requires the daemon MCP listener before accepting a search', async () => {
    const { app, runtime } = await fixture();
    const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'Find a film' } });
    expect(start.statusCode).toBe(503);
    expect(start.json()).toMatchObject({ code: 'operation-unavailable' });
    expect(runtime.activity().items).toHaveLength(0);
  });
  it('runs the canonical async plan through the bound daemon MCP route and persists a release set', async () => {
    let responseCalls = 0;
    const modelInputs: unknown[] = [];
    const responses = createServer(async (request, response) => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString()) as { tools?: Array<{ name?: string }>; input?: unknown; instructions?: unknown };
      modelInputs.push({ input: body.input, instructions: body.instructions });
      responseCalls++;
      const name = (responseCalls === 1 ? body.tools?.find(tool => tool.name?.includes('prowlarr_search'))?.name : undefined) ?? 'finalize_release_set';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: `fixture-${Date.now()}`, object: 'response', created_at: 1, completed_at: 1, status: 'completed',
        error: null, incomplete_details: null, instructions: null, model: 'z-ai/glm-5.3-flash',
        output: [{ id: `call-${Date.now()}`, type: 'function_call', call_id: `call-${Date.now()}`, name,
          arguments: name?.includes('prowlarr_search') ? JSON.stringify({ query: 'Find a film' })
            : JSON.stringify({ status: 'no-match', selections: [], gaps: [], deferred: [], broadCoverage: 'none' }), status: 'completed' }],
        parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 150, cost: 0.004 }, metadata: null,
        frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      }));
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const upstream = responses.address();
    if (!upstream || typeof upstream === 'string') throw new Error('Missing scripted Responses address');
    const { app, runtime, grabs } = await fixture();
    try {
      runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, baseUrl: `http://127.0.0.1:${upstream.port}` } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'Find a film', context: { kind: 'movie', titles: ['Arrival'], year: 2016, scope: { type: 'movie' } } } });
      expect(start.statusCode).toBe(202);
      const { searchId } = start.json() as { searchId: string };
      await runtime.drain();
      const instruction = JSON.stringify(modelInputs);
      expect(instruction).toContain('typed finalize_release_set');
      expect(instruction).toContain('Never redefine the requested scope');
      expect(instruction).toContain('do not force a fixed number of queries');
      expect(instruction).toContain('incidental extra seasons/episodes in a pack are overcoverage warnings, not gaps');
      const status = await app.inject(`/api/v2/searches/${searchId}`);
      expect(status.statusCode).toBe(200);
      expect(status.json(), JSON.stringify(status.json())).toMatchObject({
        searchId, status: 'no-match', diagnostics: { modelTurns: 2, stopReason: 'release-set-finalized', elapsedMs: expect.any(Number), usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cost: 0.004 } },
        counts: { decisions: 2, searches: 1 },
        plan: { version: 1, status: 'no-match', selections: [], coverage: { broad: { status: 'none' } } },
      });
      expect(status.body).not.toContain('private-model');
      expect(grabs()).toBe(0);
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>((resolve, reject) => responses.close(error => error ? reject(error) : resolve()));
    }
  });
  it.each([
    { name: 'zero then conflicting positive identity', identities: [0, 999], expected: 'failed' },
    { name: 'conflicting positive then zero identity', identities: [999, 0], expected: 'failed' },
    { name: 'unknown zero identity only', identities: [0, 0], expected: 'matched' },
  ])('validates every matched candidate identity observation ($name)', async ({ identities, expected }) => {
    let runtimeRef: SearchRuntime | undefined, responseCalls = 0, searchCall = 0;
    const responses = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      responseCalls++;
      if (responseCalls > 3) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'CANARY-RESPONSE-BODY-DO-NOT-LEAK' }));
        return;
      }
      const requestBody = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: Array<{ name?: string }> };
      const searchName = requestBody.tools?.find(tool => tool.name?.includes('prowlarr_search'))?.name;
      const name = responseCalls <= 2 ? searchName ?? 'prowlarr_search' : 'finalize_release_set';
      let args: unknown;
      if (responseCalls <= 2) { searchCall++; args = { query: `identity-${searchCall}` }; }
      else {
        const candidateId = runtimeRef!.store.listCandidates(runtimeRef!.activity().items[0]!.searchId)[0]?.candidateId;
        args = { status: 'matched', selections: [{ candidateId, targetIds: ['opaque-target'], reason: 'Observed candidate', uncertainty: '' }], gaps: [], deferred: [] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: `identity-${responseCalls}`, object: 'response', created_at: 1, completed_at: 1, status: 'completed',
        error: null, incomplete_details: null, instructions: null, model: 'fixture/model',
        output: [{ id: `call-${responseCalls}`, type: 'function_call', call_id: `call-${responseCalls}`, name, arguments: JSON.stringify(args), status: 'completed' }],
        parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: null, metadata: null,
        frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      }));
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const address = responses.address();
    if (!address || typeof address === 'string') throw new Error('No fixture Responses listener');
    const { app, runtime, grabs } = await fixture({
      prowlarr: {
        getIndexers: async () => [{ id: 1, name: 'Index', enable: true }],
        getIndexerStatuses: async () => [],
        search: async () => [releaseSchema.parse({
          guid: `guid-${searchCall}`, age: 1, size: 100, files: null, grabs: null, indexerId: 1, indexer: 'Index', subGroup: null,
          title: 'Film 2020', tvdbId: null, tmdbId: identities[searchCall - 1] ?? 0, publishDate: '', downloadUrl: null,
          indexerFlags: [], categories: [], magnetUrl: null, infoHash: 'a'.repeat(40), seeders: 1, leechers: 0, protocol: 'torrent', downloadClientId: null,
        })],
      },
    });
    runtimeRef = runtime;
    try {
      runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, baseUrl: `http://127.0.0.1:${address.port}` } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: {
        prompt: 'Find film', context: { kind: 'movie', titles: ['Film'], externalIds: { tmdb: 123 }, targets: [{ targetId: 'opaque-target' }] },
      } });
      const { searchId } = start.json() as { searchId: string };
      await runtime.drain();
      const result = await runtime.getSearch(searchId);
      expect(result?.status, JSON.stringify(result)).toBe(expected);
      expect(result?.plan?.selections.length ?? 0).toBe(expected === 'matched' ? 1 : 0);
      expect(result?.candidates).toMatchObject([{ observations: expect.arrayContaining([expect.objectContaining({ tmdbId: identities[0] }), expect.objectContaining({ tmdbId: identities[1] })]) }]);
      expect(result?.message ?? '').not.toContain('CANARY-RESPONSE-BODY-DO-NOT-LEAK');
      if (expected === 'failed') expect(result?.message).toBe('Search provider request failed (HTTP 500)');
      expect(result?.counts.decisions).toBeGreaterThan(0);
      if (expected === 'matched') {
        runtime.store.expireCandidatesAt(searchId, Date.now() - 1);
        expect(runtime.store.listCandidates(searchId)).toHaveLength(0);
        const historical = await runtime.getSearch(searchId);
        expect(historical?.candidates).toMatchObject([{ observations: [{ title: 'Film 2020', tmdbId: 0 }] }]);
        expect(JSON.stringify(historical)).not.toContain('guid-');
      }
      expect(grabs()).toBe(0);
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>((resolve, reject) => responses.close(error => error ? reject(error) : resolve()));
    }
  });
  it.each([{ header: '30', minSeconds: 29 }, { header: null, minSeconds: 59 }])('sanitizes model 429 bodies, applies Retry-After/fallback, and pauses queued work', async ({ header, minSeconds }) => {
    let modelCalls = 0;
    const responses = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume */ }
      modelCalls++;
      response.writeHead(429, { 'content-type': 'application/json', ...(header ? { 'retry-after': header } : {}) });
      response.end(JSON.stringify({ error: 'MODEL-CANARY-PRIVATE-BODY' }));
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const address = responses.address();
    if (!address || typeof address === 'string') throw new Error('No fixture Responses listener');
    const { app, runtime } = await fixture();
    try {
      runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, baseUrl: `http://127.0.0.1:${address.port}` } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const before = Date.now();
      const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'First' } });
      const { searchId } = start.json() as { searchId: string };
      await runtime.drain();
      const status = await runtime.getSearch(searchId);
      expect(status).toMatchObject({ status: 'failed', message: 'Model provider rate limited the search' });
      expect(JSON.stringify(status)).not.toContain('MODEL-CANARY-PRIVATE-BODY');
      expect(runtime.store.getProviderDeadline('model')).toBeGreaterThanOrEqual(before + minSeconds * 1000);
      await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'Queued behind cooldown' } });
      expect(modelCalls).toBe(1);
      expect(runtime.activity().items[0]?.status).toBe('queued');
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>((resolve, reject) => responses.close(error => error ? reject(error) : resolve()));
    }
  });
  it('aborts the active model request on quiesce and never persists a staged plan', async () => {
    let seenRequest!: () => void, responseClosed!: () => void;
    const seen = new Promise<void>(resolve => { seenRequest = resolve; });
    const closed = new Promise<void>(resolve => { responseClosed = resolve; });
    const responses = createServer((request, response) => {
      request.resume();
      response.once('close', responseClosed);
      seenRequest();
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const address = responses.address();
    if (!address || typeof address === 'string') throw new Error('No fixture Responses listener');
    const { app, runtime, grabs } = await fixture();
    try {
      runtime.saveSettings({ ...runtime.getSettings(), ai: { ...runtime.getSettings().ai, baseUrl: `http://127.0.0.1:${address.port}` } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'Stop during model call' } });
      const { searchId } = start.json() as { searchId: string };
      await seen;
      runtime.quiesce();
      await runtime.drain();
      await closed;
      expect(await runtime.getSearch(searchId)).toMatchObject({ status: 'interrupted' });
      expect((await runtime.getSearch(searchId))?.plan).toBeUndefined();
      expect(grabs()).toBe(0);
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>(resolve => responses.close(() => resolve()));
    }
  }, 15_000);
  it('never contacts providers when reading Activity or Automation', async () => {
    const { app, reads } = await fixture();
    expect((await app.inject('/api/v2/activity')).statusCode).toBe(200);
    expect((await app.inject('/api/v2/automation')).json()).toMatchObject({ enabled: false, dryRun: true, items: [] });
    expect(reads()).toBe(0);
  });
  it('validates bounded Activity media/time filters and rejects reversed ranges', async () => {
    const { app, runtime } = await fixture(), now = Date.now();
    runtime.store.createSearch({ searchId: 'tv', prompt: '{"prompt":"Example","context":{"kind":"tv"}}', status: 'no-match', createdAt: now });
    expect((await app.inject(`/api/v2/activity?kind=tv&createdAtFrom=${encodeURIComponent(new Date(now).toISOString())}&createdAtTo=${encodeURIComponent(new Date(now).toISOString())}`)).json()).toMatchObject({ total: 1, items: [{ kind: 'tv' }] });
    expect((await app.inject('/api/v2/activity?kind=bogus')).statusCode).toBe(400);
    expect((await app.inject('/api/v2/activity?createdAtFrom=not-a-date')).statusCode).toBe(400);
    expect((await app.inject('/api/v2/activity?createdAtFrom=2026-02-01T00%3A00%3A00Z&createdAtTo=2026-01-01T00%3A00%3A00Z')).statusCode).toBe(400);
  });
  it('requires valid input and rejects cross-origin mutations without network work', async () => {
    const { app, reads } = await fixture();
    expect((await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v2/searches', headers: { origin: 'http://evil.test' }, payload: { prompt: 'Find' } })).statusCode).toBe(403);
    expect((await app.inject('/api/v2/activity?limit=999')).statusCode).toBe(400);
    expect((await app.inject('/api/v2/searches/unknown')).statusCode).toBe(404);
    expect(reads()).toBe(0);
  });
  it('uses v2 settings with optional Arr and omits all legacy mutation routes', async () => {
    const { app, grabs } = await fixture();
    expect((await app.inject('/api/settings')).json()).toMatchObject({ settings: { version: 3 }, status: { ready: true } });
    expect((await app.inject({ method: 'POST', url: '/cycle' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/operations/work/action', payload: { action: 'reset' } })).statusCode).toBe(404);
    expect(grabs()).toBe(0);
  });
});
