import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildApp } from '../src/daemon';
import { MAX_PROWLARR_MCP_CAPABILITY_TTL_MS, SearchRuntime } from '../src/search/runtime';
import { defaultSettings } from '../src/search/settings';
import { openSearchStore } from '../src/search/store';
import type { Stack } from '../src/compose';
import pino from 'pino';
import { createMCPTools } from '@openrouter/agent/mcp';
import { ApiError } from '../src/http';
import { releaseSchema } from '../src/types/prowlarr';

describe('internal Prowlarr Streamable HTTP MCP', () => {
  it.each(['discovery', 'search'])('aborts sibling discovery reads when %s fails early', async operation => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://fixture.test', apiKey: 'fixture-key', tvClient: '', movieClient: '' };
    let siblingSignal: AbortSignal | undefined;
    const runtime = new SearchRuntime({
      initialSettings: settings, store: openSearchStore(':memory:'),
      clients: () => ({ prowlarr: {
        getIndexers: async () => { throw new ApiError(503, 'private-url', 'private-body'); },
        getIndexerStatuses: async options => {
          siblingSignal = options?.signal;
          return new Promise((_resolve, reject) => siblingSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        },
        search: async () => [], getDownloadClients: async () => [], grab: async () => { throw new Error('forbidden'); },
      } }),
    });
    try {
      runtime.store.createSearch({ searchId: 'sibling', prompt: 'test', status: 'running', createdAt: Date.now() });
      const { token } = runtime.createProwlarrMcpCapability('sibling');
      await expect(operation === 'discovery' ? runtime.prowlarrIndexerDiscovery(token) : runtime.prowlarrSearch(token, { query: 'test' })).rejects.toThrow('failed');
      expect(siblingSignal?.aborted).toBe(true);
    } finally { await runtime.close(); }
  });

  it('serves real SDK discovery and safe search through a scoped bearer capability', async () => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://prowlarr.test', apiKey: 'SECRET-KEY', tvClient: '', movieClient: '' };
    let grabs = 0;
    const runtime = new SearchRuntime({
      initialSettings: settings, store: openSearchStore(':memory:'),
      clients: () => ({ prowlarr: {
        getIndexers: async () => [{ id: 1, name: 'SECRET-KEY Indexer', enable: true, supportsSearch: true, supportsRss: false, capabilities: { categories: [{ id: 5000, name: 'SECRET-KEY TV' }] } }],
        getIndexerStatuses: async () => [],
        search: async params => {
          if (params.query === 'Sample') expect(params.type).toBe('moviesearch');
          const release = {
          guid: 'private-guid', age: 1, size: 42, files: null, grabs: null, indexerId: 1,
          indexer: 'SECRET-KEY Indexer', subGroup: null,
          title: 'Sample https://private.test/SECRET-KEY?download=1 S01E01 private-guid',
          tvdbId: null, tmdbId: null, publishDate: '', downloadUrl: 'https://private.test/SECRET-KEY',
          indexerFlags: ['SECRET-KEY magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789'],
          categories: [{ id: 5000, name: 'SECRET-KEY category private-guid' }], magnetUrl: null, infoHash: null,
          seeders: 1, leechers: 0, protocol: 'torrent' as const, downloadClientId: null,
          };
          return [release, { ...release, title: 'Sample S02E01' }];
        },
        getDownloadClients: async () => [{ id: 1, name: 'Test', protocol: 'torrent', enable: true, supportsCategories: true, categories: [] }], grab: async () => { grabs++; },
      } }),
    });
    const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    let client: Client | undefined;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      runtime.store.createSearch({ searchId: 'owner-search', prompt: '{"prompt":"test"}', status: 'running', createdAt: Date.now() });
      const created = runtime.createProwlarrMcpCapability('owner-search');
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('No test listener');
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/internal/mcp/prowlarr`), {
        requestInit: { headers: { Authorization: `Bearer ${created.token}` } },
      });
      client = new Client({ name: 'integration', version: '1.0.0' });
      await client.connect(transport);
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['prowlarr_indexers', 'prowlarr_search']);
      const indexers = await client.callTool({ name: 'prowlarr_indexers', arguments: {} });
      expect(JSON.parse((indexers.content as Array<{ text: string }>)[0]!.text)).toMatchObject([{ categories: [{ id: 5000, name: '[redacted] TV' }], supportsSearch: true }]);
      expect(JSON.stringify(indexers)).not.toContain('SECRET-KEY');
      const openrouter = await createMCPTools({ url: `http://127.0.0.1:${address.port}/internal/mcp/prowlarr`, transport: 'streamableHttp', auth: { kind: 'bearer', token: created.token } });
      try {
        const searchTool = (openrouter.tools as unknown as Array<{ function?: { name: string; execute: (args: unknown) => AsyncGenerator<unknown, unknown, unknown> } }>).find(tool => tool.function?.name.includes('prowlarr_search'));
        expect(searchTool).toBeDefined();
        const execution = searchTool!.function!.execute({ query: 'Adapter execution', categories: [5000] });
        const executed = await execution.next();
        expect(JSON.stringify(executed)).toContain('candidateId');
      }
      finally { await openrouter.close(); }
      const found = await client.callTool({ name: 'prowlarr_search', arguments: { query: 'Sample', categories: [5000], type: 'moviesearch' } });
      const text = JSON.stringify(found);
      expect(text).toContain('candidateId');
      for (const secret of ['SECRET-KEY', 'private-guid', 'private.test', 'magnet:', 'abcdef0123456789abcdef0123456789']) expect(text).not.toContain(secret);
      expect(grabs).toBe(0);
      const candidates = JSON.parse((found.content as Array<{ text: string }>)[0]!.text) as Array<{ candidateId: string; observations: unknown[] }>;
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.observations).toHaveLength(2);
      expect(runtime.store.getCandidate('owner-search', candidates[0]!.candidateId)?.privateData).toMatchObject({ physicalKey: expect.any(String), release: { guid: 'private-guid' } });
      expect(runtime.store.getCandidate('different-owner', candidates[0]!.candidateId)).toBeNull();
      runtime.store.finishSearch('owner-search', 'matched', {
        options: [{ optionId: 'selected', rank: 1, releases: [{ candidateId: candidates[0]!.candidateId }], coveredTargetIds: [], reason: 'Observed candidate', uncertainty: '' }],
      }, Date.now());
      await expect(runtime.submit({ searchId: 'owner-search', optionId: 'selected', idempotencyKey: 'internal-mcp-candidate', downloadClientId: 1 })).resolves.toMatchObject({
        outcome: 'dry-run', candidateIds: [candidates[0]!.candidateId],
      });
      const unauthorized = await app.inject({ method: 'POST', url: '/internal/mcp/prowlarr', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      expect(unauthorized.statusCode).toBe(401);
      const wrongToken = `${created.token[0] === '0' ? '1' : '0'}${created.token.slice(1)}`;
      const mismatched = await app.inject({ method: 'POST', url: '/internal/mcp/prowlarr', headers: { authorization: `Bearer ${wrongToken}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      expect(mismatched.statusCode).toBe(401);
      const invalid = await client.callTool({ name: 'prowlarr_search', arguments: { query: ' ', searchId: 'somebody-elses-search' } });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).not.toContain('SECRET-KEY');
      const suppliedScope = await client.callTool({ name: 'prowlarr_search', arguments: { query: 'Sample', searchId: 'somebody-elses-search' } });
      expect(suppliedScope.isError).toBe(true);
    } finally {
      await client?.close();
      await app.close();
      await runtime.close();
    }
  });

  it('honors per-job snapshots, healthy selection, cooldown and sanitized upstream errors', async () => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://original.test', apiKey: 'old-secret', tvClient: '', movieClient: '' };
    let clientUrl = '', searchCalls = 0;
    const runtime = new SearchRuntime({
      initialSettings: settings, store: openSearchStore(':memory:'),
      clients: current => {
        clientUrl = current.integrations.prowlarr.url;
        return { prowlarr: {
          getIndexers: async () => [{ id: 1, name: 'A', enable: true }, { id: 2, name: 'B', enable: false }],
          getIndexerStatuses: async () => [{ indexerId: 1, disabledTill: new Date(Date.now() + 60_000).toISOString(), mostRecentFailure: null, initialFailure: null }],
          search: async () => { searchCalls++; throw new ApiError(429, 'private-url?apikey=old-secret', 'old-secret', 45); },
          getDownloadClients: async () => [], grab: async () => {},
        } };
      },
    });
    try {
      runtime.store.createSearch({ searchId: 'search-snapshot', prompt: '{"prompt":"test"}', status: 'running', createdAt: Date.now() });
      const capability = runtime.createProwlarrMcpCapability('search-snapshot');
      const updated = structuredClone(settings); updated.integrations.prowlarr.url = 'http://changed.test';
      expect(runtime.saveSettings(updated).ok).toBe(true);
      await expect(runtime.prowlarrSearch(capability.token, { query: 'example' })).rejects.toThrow('no-healthy-indexers');
      expect(searchCalls).toBe(0);
      expect((await runtime.prowlarrIndexerDiscovery(capability.token)).map(i => i.available)).toEqual([false, false]);
      expect(clientUrl).toBe('http://original.test');
      runtime.store.setProviderDeadline('prowlarr', 0);
      const coolingSettings = structuredClone(settings);
      const runtime2 = new SearchRuntime({
        initialSettings: coolingSettings, store: openSearchStore(':memory:'),
        clients: () => ({ prowlarr: {
          getIndexers: async () => [{ id: 1, name: 'A', enable: true, supportsSearch: false }, { id: 2, name: 'Compatible legacy indexer', enable: true }],
          getIndexerStatuses: async () => [],
          search: async params => {
            expect(params.indexerIds).toEqual([2]);
            throw new ApiError(429, 'https://private.test?apikey=old-secret', 'old-secret');
          },
          getDownloadClients: async () => [], grab: async () => {},
        } }),
      });
      runtime2.store.createSearch({ searchId: 'scope', prompt: '{"prompt":"test"}', status: 'running', createdAt: Date.now() });
      const token = runtime2.createProwlarrMcpCapability('scope').token;
      expect(runtime2.hasProwlarrMcpCapability(token)).toBe(true);
      expect(runtime2.store.getProviderDeadline('prowlarr')).toBeNull();
      await expect(runtime2.prowlarrSearch(token, { query: 'example' })).rejects.toThrow('Prowlarr search failed');
      expect(runtime2.store.getProviderDeadline('prowlarr')).toBeGreaterThan(Date.now());
      await expect(runtime2.prowlarrSearch(token, { query: 'example' })).rejects.toThrow('provider-cooldown');
      runtime2.revokeProwlarrMcpCapability(token);
      expect(runtime2.hasProwlarrMcpCapability(token)).toBe(false);
      const shutdownToken = runtime2.createProwlarrMcpCapability('scope').token;
      await runtime2.close();
      expect(runtime2.hasProwlarrMcpCapability(shutdownToken)).toBe(false);
    } finally { await runtime.close(); }
  });

  it('serializes same-scope candidate identity, rejects empty selection, cancels upstream and expires capabilities', async () => {
    let now = 10_000, searches = 0, grabs = 0, observedSignal: AbortSignal | undefined, shutdownStarted!: () => void;
    const shutdownUpstreamStarted = new Promise<void>(resolve => { shutdownStarted = resolve; });
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://prowlarr.test', apiKey: 'test-key', tvClient: '', movieClient: '' };
    const release = {
      guid: 'private-guid', age: 1, size: 42, files: null, grabs: null, indexerId: 1, indexer: 'Indexer', subGroup: null,
      title: 'Series S01E01 1080p', tvdbId: null, tmdbId: null, publishDate: '', downloadUrl: null,
      indexerFlags: [], categories: [], magnetUrl: null, infoHash: null, seeders: 1, leechers: 0, protocol: 'torrent', downloadClientId: null,
    };
    const runtime = new SearchRuntime({
      now: () => now, initialSettings: settings, store: openSearchStore(':memory:'),
      clients: () => ({ prowlarr: {
        getIndexers: async () => [{ id: 1, name: 'Indexer', enable: true }],
        getIndexerStatuses: async () => [],
        search: async (_query, options) => {
          searches++; observedSignal = options?.signal;
          if (_query.query === 'shutdown') shutdownStarted();
          if (options?.signal?.aborted) throw new Error('aborted');
          if (_query.query === 'timeout' || _query.query === 'shutdown') await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 3);
            options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
          });
          return [release] as never;
        },
        getDownloadClients: async () => [], grab: async () => { grabs++; },
      } }),
    });
    try {
      runtime.store.createSearch({ searchId: 'shared-scope', prompt: '{"prompt":"test"}', status: 'running', createdAt: now });
      expect(runtime.createProwlarrMcpCapability('shared-scope', 30 * 60_000).expiresAt).toBe(now + 30 * 60_000);
      expect(() => runtime.createProwlarrMcpCapability('shared-scope', MAX_PROWLARR_MCP_CAPABILITY_TTL_MS + 1)).toThrow('invalid-capability-lifetime');
      const capability = runtime.createProwlarrMcpCapability('shared-scope');
      await expect(runtime.prowlarrSearch(capability.token, { query: 'x', indexerIds: [7] })).rejects.toThrow('no-healthy-indexers');
      const [a, b] = await Promise.all([
        runtime.prowlarrSearch(capability.token, { query: 'same' }),
        runtime.prowlarrSearch(capability.token, { query: 'same' }),
      ]);
      expect((a[0] as { candidateId: string }).candidateId).toBe((b[0] as { candidateId: string }).candidateId);
      expect(runtime.store.listCandidates('shared-scope', now)).toHaveLength(1);
      expect(searches).toBe(2);
      const abortingCapability = runtime.createProwlarrMcpCapability('shared-scope');
      const abort = new AbortController();
      const pending = runtime.prowlarrSearch(abortingCapability.token, { query: 'cancel' }, abort.signal);
      abort.abort();
      await expect(pending).rejects.toThrow('Prowlarr search failed');
      expect(observedSignal?.aborted).toBe(true);
      const timeoutCapability = runtime.createProwlarrMcpCapability('shared-scope');
      await expect(runtime.prowlarrSearch(timeoutCapability.token, { query: 'timeout', timeoutMs: 100 })).rejects.toThrow('Prowlarr search failed');
      expect(observedSignal?.aborted).toBe(true);
      const expiring = runtime.createProwlarrMcpCapability('shared-scope', 1_000);
      now += 1_001;
      expect(runtime.hasProwlarrMcpCapability(expiring.token)).toBe(false);
      const shutdown = runtime.createProwlarrMcpCapability('shared-scope');
      const inFlight = runtime.prowlarrSearch(shutdown.token, { query: 'shutdown' });
      await shutdownUpstreamStarted;
      await runtime.close();
      await expect(inFlight).rejects.toThrow('Prowlarr search failed');
      expect(observedSignal?.aborted).toBe(true);
      expect(grabs).toBe(0);
    } finally { await runtime.close(); }
  });

  it('forwards a real served SDK cancellation to its active upstream Prowlarr request', async () => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://prowlarr.test', apiKey: 'test-key', tvClient: '', movieClient: '' };
    let searchSignal: AbortSignal | undefined, started!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
    const runtime = new SearchRuntime({
      initialSettings: settings, store: openSearchStore(':memory:'),
      clients: () => ({ prowlarr: {
        getIndexers: async () => [{ id: 1, name: 'Indexer', enable: true }],
        getIndexerStatuses: async () => [],
        search: async (_input, options) => {
          searchSignal = options?.signal;
          started();
          await new Promise<void>((_resolve, reject) => {
            if (searchSignal?.aborted) reject(new Error('aborted'));
            else searchSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return [];
        },
        getDownloadClients: async () => [], grab: async () => {},
      } }),
    });
    const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    const client = new Client({ name: 'cancel-test', version: '1.0.0' });
    try {
      runtime.store.createSearch({ searchId: 'served-cancel', prompt: '{"prompt":"test"}', status: 'running', createdAt: Date.now() });
      const { token } = runtime.createProwlarrMcpCapability('served-cancel');
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('No test listener');
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/internal/mcp/prowlarr`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      const abort = new AbortController();
      const call = client.callTool({ name: 'prowlarr_search', arguments: { query: 'hang' } }, { signal: abort.signal });
      await upstreamStarted;
      abort.abort();
      await expect(call).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(searchSignal?.aborted).toBe(true);
    } finally {
      await client.close();
      await app.close();
      await runtime.close();
    }
  });

  it('binds independent served MCP sessions and candidate ledgers to their bearer capabilities', async () => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://source-a.test', apiKey: 'same-key', tvClient: '', movieClient: '' };
    let grabs = 0;
    const runtime = new SearchRuntime({
      initialSettings: settings, store: openSearchStore(':memory:'),
      clients: current => ({ prowlarr: {
        getIndexers: async () => [{ id: 1, name: 'Indexer', enable: true }],
        getIndexerStatuses: async () => [],
        search: async () => [releaseSchema.parse({
          guid: current.integrations.prowlarr.url, age: 1, indexerId: 1, indexer: 'Indexer',
          title: `Result ${current.integrations.prowlarr.url} S01E01`, publishDate: '', protocol: 'torrent',
        })],
        getDownloadClients: async () => [], grab: async () => { grabs++; },
      } }),
    });
    const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    const clients: Client[] = [], sessionIds = new Map<string, string>();
    try {
      runtime.store.createSearch({ searchId: 'owner-a', prompt: '{"prompt":"A"}', status: 'running', createdAt: Date.now() });
      runtime.store.createSearch({ searchId: 'owner-b', prompt: '{"prompt":"B"}', status: 'running', createdAt: Date.now() });
      const tokenA = runtime.createProwlarrMcpCapability('owner-a').token;
      const changed = structuredClone(settings); changed.integrations.prowlarr.url = 'http://source-b.test';
      expect(runtime.saveSettings(changed).ok).toBe(true);
      const tokenB = runtime.createProwlarrMcpCapability('owner-b').token;
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('No test listener');
      const connect = async (token: string) => {
        const client = new Client({ name: 'scope-test', version: '1.0.0' });
        clients.push(client);
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/internal/mcp/prowlarr`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            const sessionId = response.headers.get('mcp-session-id');
            if (sessionId) sessionIds.set(token, sessionId);
            return response;
          },
        });
        await client.connect(transport);
        return client;
      };
      const [clientA, clientB] = await Promise.all([connect(tokenA), connect(tokenB)]);
      const [resultA, resultB] = await Promise.all([
        clientA.callTool({ name: 'prowlarr_search', arguments: { query: 'A' } }),
        clientB.callTool({ name: 'prowlarr_search', arguments: { query: 'B' } }),
      ]);
      const candidateA = JSON.parse((resultA.content as Array<{ text: string }>)[0]!.text)[0] as { candidateId: string };
      const candidateB = JSON.parse((resultB.content as Array<{ text: string }>)[0]!.text)[0] as { candidateId: string };
      expect(candidateA.candidateId).not.toBe(candidateB.candidateId);
      expect(runtime.store.getCandidate('owner-a', candidateA.candidateId)).not.toBeNull();
      expect(runtime.store.getCandidate('owner-a', candidateA.candidateId)?.privateData).toMatchObject({ release: { guid: 'http://source-a.test' } });
      expect(runtime.store.getCandidate('owner-a', candidateB.candidateId)).toBeNull();
      expect(runtime.store.getCandidate('owner-b', candidateB.candidateId)).not.toBeNull();
      expect(runtime.store.getCandidate('owner-b', candidateB.candidateId)?.privateData).toMatchObject({ release: { guid: 'http://source-b.test' } });
      expect(runtime.store.getCandidate('owner-b', candidateA.candidateId)).toBeNull();
      const sessionA = sessionIds.get(tokenA), sessionB = sessionIds.get(tokenB);
      expect(sessionIds.size).toBe(2);
      expect(sessionA).not.toBe(sessionB);
      const crossScope = await app.inject({
        method: 'POST', url: '/internal/mcp/prowlarr',
        headers: { authorization: `Bearer ${tokenB}`, 'mcp-session-id': sessionA! },
        payload: { jsonrpc: '2.0', id: 99, method: 'tools/list' },
      });
      expect(crossScope.statusCode).toBe(404);
      expect(grabs).toBe(0);
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await app.close();
      await runtime.close();
    }
  });

  it('aborts real upstream HTTP on served timeout, active expiry and shutdown, without grabs', async () => {
    const within = async <T>(operation: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 3_000); })]);
      } finally { clearTimeout(timer); }
    };
    let mode: 'timeout' | 'expiry' | 'shutdown' | 'rate-limit' = 'timeout';
    let started!: () => void, aborted!: () => void, posts = 0;
    let upstreamStarted = Promise.resolve(), upstreamAborted = Promise.resolve();
    const begin = (next: typeof mode) => {
      mode = next;
      upstreamStarted = new Promise<void>(resolve => { started = resolve; });
      upstreamAborted = new Promise<void>(resolve => { aborted = resolve; });
    };
    const upstream = createServer((request, response) => {
      if (request.method !== 'GET') posts++;
      response.setHeader('content-type', 'application/json');
      if (request.url?.startsWith('/api/v1/indexerstatus')) return response.end('[]');
      if (request.url?.startsWith('/api/v1/indexer')) return response.end(JSON.stringify([{ id: 1, name: 'Fixture', enable: true, supportsSearch: true }]));
      if (request.url?.startsWith('/api/v1/search')) {
        started();
        if (mode === 'rate-limit') {
          response.statusCode = 429;
          return response.end('private upstream error');
        }
        response.on('close', () => aborted());
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('No upstream listener');
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'fixture-key', tvClient: '', movieClient: '' };
    let clockOffset = 0;
    const runtime = new SearchRuntime({ initialSettings: settings, store: openSearchStore(':memory:'), now: () => Date.now() + clockOffset });
    const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    const clients: Client[] = [];
    try {
      runtime.store.createSearch({ searchId: 'real-upstream', prompt: '{"prompt":"test"}', status: 'running', createdAt: Date.now() });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('No test listener');
      const connect = async (ttl = 60_000) => {
        const capability = runtime.createProwlarrMcpCapability('real-upstream', ttl);
        const client = new Client({ name: 'lifecycle-test', version: '1.0.0' });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/internal/mcp/prowlarr`), {
          requestInit: { headers: { Authorization: `Bearer ${capability.token}` } },
        }));
        return { client, capability };
      };
      begin('timeout');
      const timeout = await connect();
      const timedOut = timeout.client.callTool({ name: 'prowlarr_search', arguments: { query: 'slow', timeoutMs: 100 } });
      await within(upstreamStarted, 'timeout request start');
      expect((await timedOut).isError).toBe(true);
      await within(upstreamAborted, 'timeout upstream abort');
      expect(runtime.store.listCandidates('real-upstream')).toEqual([]);

      begin('rate-limit');
      const limited = await timeout.client.callTool({ name: 'prowlarr_search', arguments: { query: 'limited' } });
      expect(limited.isError).toBe(true);
      expect(JSON.stringify(limited)).not.toContain('private upstream error');
      expect(runtime.store.getProviderDeadline('prowlarr')).toBeGreaterThan(Date.now() + 50_000);
      clockOffset += 61_000; // Provider deadlines deliberately cannot be shortened by writing zero.

      begin('expiry');
      const expiring = await connect(1_000);
      const expires = expiring.client.callTool({ name: 'prowlarr_search', arguments: { query: 'expires' } }).catch(() => ({ isError: true }));
      await within(upstreamStarted, 'expiry request start');
      await within(upstreamAborted, 'expiry upstream abort');
      expect((await within(expires, 'expiry client settlement')).isError).toBe(true);
      expect(runtime.hasProwlarrMcpCapability(expiring.capability.token)).toBe(false);
      expect(runtime.store.listCandidates('real-upstream')).toEqual([]);

      begin('shutdown');
      const closing = await connect();
      const closes = closing.client.callTool({ name: 'prowlarr_search', arguments: { query: 'shutdown' } }).catch(() => ({ isError: true }));
      await within(upstreamStarted, 'shutdown request start');
      await within(runtime.close(), 'runtime close');
      await within(upstreamAborted, 'shutdown upstream abort');
      expect((await within(closes, 'shutdown client settlement')).isError).toBe(true);
      expect(posts).toBe(0);
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await app.close();
      await runtime.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
  }, 10_000);
});
