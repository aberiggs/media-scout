import { describe, expect, it, vi } from 'vitest';
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
import { OpenRouter } from '@openrouter/sdk';
import { runAgentSearch } from '../src/search/agent';

describe('internal Prowlarr Streamable HTTP MCP', () => {
  it('uses the search aggregate budget for discovery and search while keeping standalone discovery at 15 seconds', async () => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: 'http://fixture.test', apiKey: 'fixture-key' };
    const timeouts: Array<number | undefined> = [];
    const runtime = new SearchRuntime({ initialSettings: settings, store: openSearchStore(':memory:'), clients: () => ({ prowlarr: {
      getIndexers: async options => { timeouts.push(options?.timeoutMs); return [{ id: 1, name: 'A', enable: true }]; },
      getIndexerStatuses: async options => { timeouts.push(options?.timeoutMs); return []; },
      search: async (_input, options) => { timeouts.push(options?.timeoutMs); return []; },
      getDownloadClients: async () => [], grab: async () => { throw new Error('unexpected grab'); },
    } }) });
    try {
      runtime.store.createSearch({ searchId: 'budgets', prompt: '{}', status: 'running', createdAt: Date.now() });
      const { token } = runtime.createProwlarrMcpCapability('budgets');
      await runtime.prowlarrIndexerDiscovery(token);
      expect(timeouts.splice(0)).toEqual([15_000, 15_000]);
      await runtime.prowlarrSearch(token, { query: 'default' });
      expect(timeouts.splice(0)).toEqual([240_000, 240_000, 240_000]);
      await runtime.prowlarrSearch(token, { query: 'short', timeoutMs: 500 });
      expect(timeouts.splice(0)).toEqual([500, 500, 500]);
      await runtime.prowlarrSearch(token, { query: 'ceiling', timeoutMs: 300_000 });
      expect(timeouts).toEqual([240_000, 240_000, 240_000]);
    } finally { await runtime.close(); }
  });

  it('never accepts natural-language or empty output as a plan, nor runs a finalizer after lease loss', async () => {
    const scenarios = [
      { name: 'empty completion', output: [], maxSteps: 4, ownsSearch: true },
      { name: 'natural-language completion', output: [{ id: 'message', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'The search looks complete.', annotations: [] }] }], maxSteps: 4, ownsSearch: true },
      { name: 'lease lost before finalizer', output: [{ id: 'final', type: 'function_call', call_id: 'final', name: 'finalize_release_set', arguments: JSON.stringify({ status: 'no-match', selections: [], covered: [], gaps: [], deferred: [], broadCoverage: 'none', scopeGaps: [] }), status: 'completed' }], maxSteps: 4, ownsSearch: false },
    ];
    for (const scenario of scenarios) {
      const responses = createServer(async (request, response) => {
        for await (const _chunk of request) { /* consume */ }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: scenario.name, object: 'response', created_at: 1, completed_at: 1, status: 'completed',
          error: null, incomplete_details: null, instructions: null, model: 'fixture/model',
          output: scenario.output, parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: null, metadata: null,
          frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
        }));
      });
      await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
      const responseAddress = responses.address();
      if (!responseAddress || typeof responseAddress === 'string') throw new Error('No Responses listener');
      const runtime = new SearchRuntime({ initialSettings: defaultSettings, store: openSearchStore(':memory:'), clients: () => ({ prowlarr: { getIndexers: async () => [], getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [], grab: async () => {} } }) });
      const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
      try {
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('No daemon listener');
        const searchId = `terminal-${scenario.name.replaceAll(' ', '-')}`;
        runtime.store.createSearch({ searchId, prompt: '{}', status: 'running', createdAt: Date.now() });
        const { token } = runtime.createProwlarrMcpCapability(searchId);
        let staged = 0;
        const result = runAgentSearch({
          client: new OpenRouter({ apiKey: 'fixture', serverURL: `http://127.0.0.1:${responseAddress.port}`, retryConfig: { strategy: 'none' } }),
          model: 'fixture/model', input: 'test', mcpUrl: `http://127.0.0.1:${address.port}/internal/mcp/prowlarr`,
          capability: token, signal: new AbortController().signal, maxSteps: scenario.maxSteps, requestTimeoutMs: 5_000,
          ledger: () => ({ searchId, candidates: [] }), ownsSearch: () => scenario.ownsSearch,
          onFinalize: () => { staged++; },
        });
        const outcome = await result.then(() => 'resolved', () => 'rejected');
        expect(outcome, scenario.name).toBe('rejected');
        expect(staged, scenario.name).toBe(0);
      } finally {
        await app.close();
        await runtime.close();
        await new Promise<void>(resolve => responses.close(() => resolve()));
      }
    }
  }, 30_000);

  it.each([
    { maxSteps: 1, finalizeAt: 1, accepted: true },
    { maxSteps: 2, finalizeAt: 2, accepted: true },
    { maxSteps: 2, finalizeAt: 3, accepted: false },
  ])('bounds SDK finalization at $maxSteps steps (finalizeAt=$finalizeAt)', async ({ maxSteps, finalizeAt, accepted }) => {
    let requests = 0;
    const responses = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume */ }
      requests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'last-turn', object: 'response', created_at: 1, completed_at: 1, status: 'completed',
        error: null, incomplete_details: null, instructions: null, model: 'fixture/model',
        output: [{ id: `call-${requests}`, type: 'function_call', call_id: `call-${requests}`,
          name: requests >= finalizeAt ? 'finalize_release_set' : 'prowlarr_indexers',
          arguments: JSON.stringify(requests >= finalizeAt ? { status: 'no-match', selections: [], covered: [], gaps: [], deferred: [], broadCoverage: 'none', scopeGaps: [] } : {}), status: 'completed' }],
        parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: null, metadata: null,
        frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      }));
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const responseAddress = responses.address();
    if (!responseAddress || typeof responseAddress === 'string') throw new Error('No Responses listener');
    const runtime = new SearchRuntime({ initialSettings: defaultSettings, store: openSearchStore(':memory:'), clients: () => ({ prowlarr: { getIndexers: async () => [], getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [], grab: async () => {} } }) });
    const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('No daemon listener');
      runtime.store.createSearch({ searchId: 'last-turn', prompt: '{}', status: 'running', createdAt: Date.now() });
      const { token } = runtime.createProwlarrMcpCapability('last-turn');
      let staged = 0;
      const result = runAgentSearch({
        client: new OpenRouter({ apiKey: 'fixture', serverURL: `http://127.0.0.1:${responseAddress.port}`, retryConfig: { strategy: 'none' } }),
        model: 'fixture/model', input: 'test', mcpUrl: `http://127.0.0.1:${address.port}/internal/mcp/prowlarr`,
        capability: token, signal: new AbortController().signal, maxSteps, requestTimeoutMs: 5_000,
        ledger: () => ({ searchId: 'last-turn', candidates: [] }), ownsSearch: () => true, onFinalize: () => { staged++; },
      });
      if (accepted) await expect(result).resolves.toMatchObject({ status: 'no-match' });
      else await expect(result).rejects.toThrow(/budget exhausted/i);
      expect(staged).toBe(accepted ? 1 : 0);
      expect(requests).toBe(finalizeAt);
    } finally {
      await app.close(); await runtime.close();
      await new Promise<void>(resolve => responses.close(() => resolve()));
    }
  });

  it.each(['127.0.0.1', '0.0.0.0', '::1', '::'])('connects real internal MCP tools through listener %s', async host => {
    const runtime = new SearchRuntime({ initialSettings: defaultSettings, store: openSearchStore(':memory:'), clients: () => ({ prowlarr: { getIndexers: async () => [], getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [], grab: async () => {} } }) });
    const origin = vi.spyOn(runtime, 'setInternalMcpUrl');
    const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    try {
      await app.listen({ host, port: 0 });
      const url = origin.mock.calls[0]![0];
      expect(new URL(url).hostname).toBe(host.includes(':') ? '[::1]' : '127.0.0.1');
      runtime.store.createSearch({ searchId: 'listener', prompt: '{}', status: 'running', createdAt: Date.now() });
      const { token } = runtime.createProwlarrMcpCapability('listener');
      const client = new Client({ name: 'listener-test', version: '1' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
        expect((await client.listTools()).tools.map(tool => tool.name)).toContain('prowlarr_indexers');
        const result = await client.callTool({ name: 'prowlarr_indexers', arguments: {} });
        expect(result.isError).not.toBe(true);
      } finally { await client.close(); }
    } finally {
      await app.close(); await runtime.close();
    }
  });

  it('cancels an active Responses request when the runner signal aborts', async () => {
    let modelRequestSeen!: () => void, modelRequestClosed!: () => void;
    const seen = new Promise<void>(resolve => { modelRequestSeen = resolve; });
    const closed = new Promise<void>(resolve => { modelRequestClosed = resolve; });
    const responses = createServer((request) => {
      request.resume();
      modelRequestSeen();
      request.once('close', modelRequestClosed);
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const responseAddress = responses.address();
    if (!responseAddress || typeof responseAddress === 'string') throw new Error('No Responses listener');
    const runtime = new SearchRuntime({ initialSettings: defaultSettings, store: openSearchStore(':memory:'), clients: () => ({ prowlarr: { getIndexers: async () => [], getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [], grab: async () => {} } }) });
    const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    const abort = new AbortController();
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('No daemon listener');
      runtime.store.createSearch({ searchId: 'cancel-runner', prompt: '{}', status: 'running', createdAt: Date.now() });
      const { token } = runtime.createProwlarrMcpCapability('cancel-runner');
      const runner = runAgentSearch({
        client: new OpenRouter({ apiKey: 'fixture', serverURL: `http://127.0.0.1:${responseAddress.port}`, retryConfig: { strategy: 'none' } }),
        model: 'fixture/model', input: 'test', mcpUrl: `http://127.0.0.1:${address.port}/internal/mcp/prowlarr`,
        capability: token, signal: abort.signal, maxSteps: 5, requestTimeoutMs: 30_000,
        ledger: () => ({ searchId: 'cancel-runner', candidates: [] }), ownsSearch: () => true, onFinalize: () => {},
      });
      await seen;
      abort.abort(new Error('cancel-test'));
      await expect(runner).rejects.toThrow();
      await closed;
      expect(runtime.hasProwlarrMcpCapability(token)).toBe(true);
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>(resolve => responses.close(() => resolve()));
    }
  }, 15_000);

  it.each(['timeout', 'failure', 'cancel', 'initialized-timeout', 'initialized-cancel'] as const)('sanitizes MCP connection %s diagnostics without mislabeling cancellation', async mode => {
    let started!: () => void, closed!: () => void;
    const seen = new Promise<void>(resolve => { started = resolve; });
    const socketClosed = new Promise<void>(resolve => { closed = resolve; });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (mode.startsWith('initialized-')) {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.method === 'initialize') {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
          }));
          return;
        }
        if (body.method !== 'notifications/initialized') { response.writeHead(404).end(); return; }
      }
      response.once('close', closed);
      started();
      if (mode === 'failure') response.writeHead(503).end('private-connection-body');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const nativeSetTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: never[]) => void, delay?: number, ...args: never[]) =>
      nativeSetTimeout(fn, mode.endsWith('timeout') && delay === 15_000 ? 150 : delay, ...args)) as unknown as typeof setTimeout);
    const abort = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = runAgentSearch({
        client: new OpenRouter({ apiKey: 'fixture', serverURL: 'http://127.0.0.1:1', retryConfig: { strategy: 'none' } }),
        model: 'fixture/model', input: 'test', mcpUrl: `http://127.0.0.1:${address.port}/mcp`, capability: 'private-token',
        signal: abort.signal, maxSteps: 1, requestTimeoutMs: 5_000,
        ledger: () => ({ searchId: 'connection', candidates: [] }), ownsSearch: () => true, onFinalize: () => {},
      });
      const completed = run.then(() => '', (reason: Error) => reason.message);
      const within = new Promise<never>((_, reject) => { watchdog = nativeSetTimeout(() => reject(new Error('MCP handshake remained open')), 1_500); });
      await Promise.race([seen, within]);
      if (mode.endsWith('cancel')) abort.abort(new Error('job-cancelled'));
      const error = await Promise.race([completed, within]);
      await Promise.race([socketClosed, within]);
      expect(error).toBe(mode.endsWith('timeout') ? 'Prowlarr MCP connection timed out.' : mode === 'failure' ? 'Prowlarr MCP connection failed.' : 'job-cancelled');
      expect(error).not.toContain('private-');
    } finally {
      clearTimeout(watchdog);
      timer.mockRestore();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('accepts only one concurrent finalizer and stages once', async () => {
    const responses = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'parallel-finalizers', object: 'response', created_at: 1, completed_at: 1, status: 'completed',
        error: null, incomplete_details: null, instructions: null, model: 'fixture/model',
        output: [1, 2].map(index => ({ id: `tool-${index}`, type: 'function_call', call_id: `call-${index}`, name: 'finalize_release_set',
          arguments: JSON.stringify({ status: 'no-match', selections: [], covered: [], gaps: [], deferred: [], broadCoverage: 'none', scopeGaps: [] }), status: 'completed' })),
        parallel_tool_calls: true, tool_choice: 'auto', tools: [], usage: null, metadata: null,
        frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      }));
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const responseAddress = responses.address();
    if (!responseAddress || typeof responseAddress === 'string') throw new Error('No Responses listener');
    const runtime = new SearchRuntime({ initialSettings: defaultSettings, store: openSearchStore(':memory:'), clients: () => ({ prowlarr: { getIndexers: async () => [], getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [], grab: async () => {} } }) });
    const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('No daemon listener');
      runtime.store.createSearch({ searchId: 'parallel-finalize', prompt: '{}', status: 'running', createdAt: Date.now() });
      const { token } = runtime.createProwlarrMcpCapability('parallel-finalize');
      let staged = 0;
      const plan = await runAgentSearch({
        client: new OpenRouter({ apiKey: 'fixture', serverURL: `http://127.0.0.1:${responseAddress.port}`, retryConfig: { strategy: 'none' } }),
        model: 'fixture/model', input: 'test', mcpUrl: `http://127.0.0.1:${address.port}/internal/mcp/prowlarr`,
        capability: token, signal: new AbortController().signal, maxSteps: 5, requestTimeoutMs: 5_000,
        ledger: () => ({ searchId: 'parallel-finalize', candidates: [] }), ownsSearch: () => true,
        onFinalize: async () => { staged++; await new Promise(resolve => setTimeout(resolve, 30)); },
      });
      expect(plan.status).toBe('no-match');
      expect(staged).toBe(1);
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>(resolve => responses.close(() => resolve()));
    }
  }, 15_000);

  it('allows a valid finalization retry after an invalid candidate reference', async () => {
    let calls = 0;
    const responses = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume */ }
      calls++;
      const arguments_ = calls === 1
        ? { status: 'matched', selections: [{ candidateId: 'fabricated', coverage: 'film', reason: 'fake', uncertainty: '' }], covered: ['film'], gaps: [], deferred: [], broadCoverage: 'complete', scopeGaps: [] }
        : { status: 'no-match', selections: [], covered: [], gaps: [], deferred: [], broadCoverage: 'none', scopeGaps: [] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: `retry-${calls}`, object: 'response', created_at: 1, completed_at: 1, status: 'completed',
        error: null, incomplete_details: null, instructions: null, model: 'fixture/model',
        output: [{ id: `call-${calls}`, type: 'function_call', call_id: `call-${calls}`, name: 'finalize_release_set', arguments: JSON.stringify(arguments_), status: 'completed' }],
        parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: null, metadata: null,
        frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      }));
    });
    await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
    const responseAddress = responses.address();
    if (!responseAddress || typeof responseAddress === 'string') throw new Error('No Responses listener');
    const runtime = new SearchRuntime({ initialSettings: defaultSettings, store: openSearchStore(':memory:'), clients: () => ({ prowlarr: { getIndexers: async () => [], getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [], grab: async () => {} } }) });
    const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('No daemon listener');
      runtime.store.createSearch({ searchId: 'retry-finalize', prompt: '{}', status: 'running', createdAt: Date.now() });
      const { token } = runtime.createProwlarrMcpCapability('retry-finalize');
      let staged = 0;
      const plan = await runAgentSearch({
        client: new OpenRouter({ apiKey: 'fixture', serverURL: `http://127.0.0.1:${responseAddress.port}`, retryConfig: { strategy: 'none' } }),
        model: 'fixture/model', input: 'test', mcpUrl: `http://127.0.0.1:${address.port}/internal/mcp/prowlarr`,
        capability: token, signal: new AbortController().signal, maxSteps: 5, requestTimeoutMs: 5_000,
        ledger: () => ({ searchId: 'retry-finalize', candidates: [] }), ownsSearch: () => true,
        onFinalize: () => { staged++; },
      });
      expect(plan.status).toBe('no-match');
      expect(staged).toBe(1);
      expect(calls).toBe(2);
    } finally {
      await app.close();
      await runtime.close();
      await new Promise<void>(resolve => responses.close(() => resolve()));
    }
  }, 15_000);

  it.each(['discovery', 'search'])('aborts sibling discovery reads when %s fails early', async operation => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: 'http://fixture.test', apiKey: 'fixture-key' };
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
    const wallClockRegression = process.env.MEDIA_SCOUT_LONG_PROWLARR_TEST === '1';
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: 'http://prowlarr.test', apiKey: 'SECRET-KEY' };
    let grabs = 0;
    const runtime = new SearchRuntime({
      initialSettings: settings, store: openSearchStore(':memory:'),
      clients: () => ({ prowlarr: {
        getIndexers: async () => [{ id: 1, name: 'SECRET-KEY Indexer', enable: true, supportsSearch: true, supportsRss: false, capabilities: { categories: [{ id: 5000, name: 'SECRET-KEY TV' }] } }],
        getIndexerStatuses: async () => [],
        search: async params => {
          if (params.query === 'Runner probe') await new Promise(resolve => setTimeout(resolve, wallClockRegression ? 121_000 : 300));
          if (params.query === 'Sample') expect(params.type).toBe('moviesearch');
          const release = {
          guid: 'private-guid', age: 1, size: 42, files: null, grabs: null, indexerId: 1,
          indexer: 'SECRET-KEY Indexer', subGroup: null,
          title: `${params.query === 'Runner probe' ? 'UniqueRunnerProbe' : 'Sample'} https://private.test/SECRET-KEY?download=1 S01E01 private-guid`,
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
      const searchDefinition = (await client.listTools()).tools.find(tool => tool.name === 'prowlarr_search')!;
      expect((searchDefinition.inputSchema.properties?.timeoutMs as { maximum?: number }).maximum).toBe(240_000);
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
       const responseRequests: Array<Record<string, unknown>> = [];
       const scriptedToolNames: Array<string | undefined> = [];
       const responses = createServer(async (request, response) => {
         const chunks: Buffer[] = [];
         for await (const chunk of request) chunks.push(Buffer.from(chunk));
         const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: Array<{ name?: string }> };
         responseRequests.push(body as Record<string, unknown>);
         const toolName = responseRequests.length === 1
           ? body.tools?.find(tool => tool.name?.includes('prowlarr_search'))?.name
           : 'finalize_release_set';
         scriptedToolNames.push(toolName);
         response.writeHead(200, { 'content-type': 'application/json' });
         response.end(JSON.stringify({
           id: `response-${responseRequests.length}`, object: 'response', created_at: 1, completed_at: 1,
           status: 'completed', error: null, incomplete_details: null, instructions: null, model: 'z-ai/glm-5.3-flash',
           output: [{ id: `call-${responseRequests.length}`, type: 'function_call', call_id: `call-${responseRequests.length}`,
             name: toolName, arguments: responseRequests.length === 1 ? JSON.stringify({ query: 'Runner probe' })
               : JSON.stringify({ status: 'no-match', selections: [], covered: [], gaps: [], deferred: [], broadCoverage: 'none', scopeGaps: [] }), status: 'completed' }],
           parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: null, metadata: null,
           frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
         }));
       });
       await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
       const responseAddress = responses.address();
       if (!responseAddress || typeof responseAddress === 'string') throw new Error('No scripted Responses listener');
       // Shorten only the MCP SDK's legacy 60-second request deadline. The
       // transport, runner and server remain real; a 300ms upstream response
       // must survive that old deadline and reach the next model turn.
       const nativeSetTimeout = globalThis.setTimeout;
       const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: never[]) => void, delay?: number, ...args: never[]) =>
         nativeSetTimeout(fn, !wallClockRegression && delay === 60_000 ? 100 : delay, ...args)) as unknown as typeof setTimeout);
       try {
         const { token: agentToken } = runtime.createProwlarrMcpCapability('owner-search');
         const result = await runAgentSearch({
           client: new OpenRouter({ apiKey: 'fixture-key', serverURL: `http://127.0.0.1:${responseAddress.port}`, retryConfig: { strategy: 'none' } }),
           model: 'z-ai/glm-5.3-flash', input: 'Search and finalize only from observations.',
           mcpUrl: `http://127.0.0.1:${address.port}/internal/mcp/prowlarr`, capability: agentToken,
           signal: new AbortController().signal, maxSteps: 5, requestTimeoutMs: 2_000,
           ledger: () => ({ searchId: 'owner-search', candidates: runtime.store.listCandidates('owner-search').map(item => {
             const value = runtime.store.getCandidate('owner-search', item.candidateId);
             return { id: item.candidateId, physicalId: String((value?.privateData as { physicalKey?: string } | undefined)?.physicalKey ?? '') };
           }) }),
           ownsSearch: () => true, onFinalize: () => undefined,
         });
         expect(result.status).toBe('no-match');
         expect(responseRequests).toHaveLength(2);
         const output = (responseRequests[1]?.input as Array<{ type?: string; output?: string }>)
           .find(item => item.type === 'function_call_output')?.output;
         expect(JSON.parse(output ?? 'null')).toEqual(expect.stringContaining('UniqueRunnerProbe'));
         expect(scriptedToolNames).toContain('finalize_release_set');
         expect(scriptedToolNames.some(name => name?.includes('prowlarr_search'))).toBe(true);
         expect((responseRequests[0]!.tools as Array<{ name: string }>).some(tool => tool.name.includes('prowlarr_search'))).toBe(true);
       } finally { timer.mockRestore(); await new Promise<void>((resolve, reject) => responses.close(error => error ? reject(error) : resolve())); }
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
  }, process.env.MEDIA_SCOUT_LONG_PROWLARR_TEST === '1' ? 135_000 : 10_000);

  it('honors per-job snapshots, healthy selection, cooldown and sanitized upstream errors', async () => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: 'http://original.test', apiKey: 'old-secret' };
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
    settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: 'http://prowlarr.test', apiKey: 'test-key' };
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
    settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: 'http://prowlarr.test', apiKey: 'test-key' };
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

  it.each(['timeout', 'context-timeout', 'cancel', 'job-deadline'] as const)('aborts real upstream work on runner %s and safely reports timeout', async mode => {
    let started!: () => void, closed!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
    const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
    let posts = 0, turns = 0, clockOffset = 0;
    const upstream = createServer((request, response) => {
      if (request.method !== 'GET') posts++;
      response.setHeader('content-type', 'application/json');
      if (request.url?.startsWith('/api/v1/indexerstatus')) return response.end('[]');
      if (request.url?.startsWith('/api/v1/indexer')) return response.end('[{"id":1,"name":"Fixture","enable":true}]');
      if (request.url?.startsWith('/api/v1/search')) { response.on('close', closed); started(); return; }
      response.writeHead(404).end('{}');
    });
    const modelBodies: string[] = [];
    const responses = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      modelBodies.push(Buffer.concat(chunks).toString());
      turns++;
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: `turn-${turns}`, object: 'response', created_at: 1, completed_at: 1, status: 'completed',
        error: null, incomplete_details: null, instructions: null, model: 'fixture/model',
        output: [{ id: `call-${turns}`, type: 'function_call', call_id: `call-${turns}`, status: 'completed',
          name: turns === 1 ? 'prowlarr_search' : 'finalize_release_set',
          arguments: JSON.stringify(turns === 1 ? { query: 'slow' } : { status: 'no-match', selections: [], covered: [], gaps: [], deferred: [], broadCoverage: 'none', scopeGaps: [] }) }],
        parallel_tool_calls: false, tool_choice: 'auto', tools: [], usage: null, metadata: null,
        frequency_penalty: null, presence_penalty: null, temperature: null, top_p: null,
      }));
    });
    await Promise.all([new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve))]);
    const upstreamAddress = upstream.address(), modelAddress = responses.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string' || !modelAddress || typeof modelAddress === 'string') throw new Error('Missing listener');
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'private-fixture-key' };
    settings.ai = { ...settings.ai, baseUrl: `http://127.0.0.1:${modelAddress.port}`, apiKey: 'fixture', model: 'fixture/model' };
    settings.search.deadlineMinutes = 1;
    const runtime = new SearchRuntime({ initialSettings: settings, store: openSearchStore(':memory:'), now: () => Date.now() + clockOffset });
    const app = await buildApp({ runtime, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    const abort = new AbortController();
    const warnings: string[] = [];
    let transportFailures = 0;
    const nativeSetTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: never[]) => void, delay?: number, ...args: never[]) => {
      if (mode === 'job-deadline' && delay !== undefined && delay >= 59_950 && delay <= 60_000)
        return nativeSetTimeout(() => { clockOffset += 60_000; fn(...args); }, 1_500);
      return nativeSetTimeout(fn, (mode === 'timeout' && delay === 250_000) || (mode === 'context-timeout' && delay === 251_000) ? 300 : delay, ...args);
    }) as unknown as typeof setTimeout);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      if (mode === 'job-deadline') {
        const response = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'search for a fixture' } });
        expect(response.statusCode).toBe(202);
        const { searchId } = response.json();
        const within = new Promise<never>((_, reject) => { watchdog = nativeSetTimeout(() => reject(new Error('Worker deadline did not close upstream')), 4_000); });
        await Promise.race([upstreamStarted, within]);
        await Promise.race([Promise.all([runtime.drain(), upstreamClosed]), within]);
        expect(await runtime.getSearch(searchId)).toMatchObject({ status: 'budget-exhausted' });
        expect(runtime.store.listCandidates(searchId)).toEqual([]);
        expect(posts).toBe(0);
        return;
      }
      runtime.store.createSearch({ searchId: 'runner-abort', prompt: '{}', status: 'running', createdAt: Date.now() });
      const { token } = runtime.createProwlarrMcpCapability('runner-abort');
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener');
      const run = runAgentSearch({
        client: new OpenRouter({ apiKey: 'fixture', serverURL: `http://127.0.0.1:${modelAddress.port}`, retryConfig: { strategy: 'none' } }),
        model: 'fixture/model', input: 'test', mcpUrl: `http://127.0.0.1:${address.port}/internal/mcp/prowlarr`,
        capability: token, signal: abort.signal, maxSteps: 4, requestTimeoutMs: 5_000,
        ledger: () => ({ searchId: 'runner-abort', candidates: [] }), ownsSearch: () => true, onFinalize: () => {},
        onResearchWarning: warning => warnings.push(warning), onProwlarrTransportFailure: () => { transportFailures++; },
      });
      await upstreamStarted;
      if (mode === 'cancel') abort.abort(new Error('job cancelled'));
      if (mode === 'cancel') await expect(run).rejects.toThrow();
      else {
        await expect(run).resolves.toMatchObject({ status: 'no-match' });
        expect(transportFailures).toBe(1);
        expect(warnings).toEqual(['Prowlarr tool invocation timed out.']);
        if (mode === 'timeout') expect(modelBodies[1]).toContain('Prowlarr tool invocation timed out.');
        expect(modelBodies[1]).not.toContain('private-fixture-key');
      }
      await Promise.race([upstreamClosed, new Promise<never>((_, reject) => nativeSetTimeout(() => reject(new Error('upstream still open')), 3_000))]);
      if (mode === 'cancel') { expect(warnings).toEqual([]); expect(transportFailures).toBe(0); }
      expect(posts).toBe(0);
    } finally {
      clearTimeout(watchdog);
      timer.mockRestore();
      await app.close(); await runtime.close();
      upstream.closeAllConnections(); responses.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => upstream.close(() => resolve())), new Promise<void>(resolve => responses.close(() => resolve()))]);
    }
  }, 15_000);

  it('binds independent served MCP sessions and candidate ledgers to their bearer capabilities', async () => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: 'http://source-a.test', apiKey: 'same-key' };
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
    settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'fixture-key' };
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
      const timeoutResult = await timedOut;
      expect(timeoutResult.isError).toBe(true);
      expect(JSON.stringify(timeoutResult)).toContain('Prowlarr search timed out.');
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
