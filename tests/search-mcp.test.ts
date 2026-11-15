import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSearchMcpServer } from '../src/search/mcp';
import { SearchRuntime, type SearchRuntimeOptions } from '../src/search/runtime';
import { openSearchStore } from '../src/search/store';
import { defaultSettings } from '../src/search/settings';

let client: Client | undefined;
let transport: InMemoryTransport | undefined;
let runtime: SearchRuntime | undefined;
afterEach(async () => { await client?.close(); await transport?.close(); await runtime?.close(); client = undefined; transport = undefined; runtime = undefined; });

async function connect(settings = defaultSettings, options: Partial<SearchRuntimeOptions> = {}) {
  runtime = new SearchRuntime({ ...options, store: openSearchStore(':memory:'), initialSettings: settings });
  const server = createSearchMcpServer(runtime);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); transport = serverSide;
  await Promise.all([server.connect(serverSide), clientSide.start()]);
  client = new Client({ name: 'search-mcp-test', version: '1.0.0' }); await client.connect(clientSide);
  return client;
}

describe('search MCP adapter', () => {
  it('shares asynchronous search, expiry and Activity contracts with HTTP without live calls', async () => {
    const settings = structuredClone(defaultSettings);
    settings.ai.apiKey = 'synthetic'; settings.integrations.prowlarr.url = 'http://indexer.test'; settings.integrations.prowlarr.apiKey = 'synthetic';
    const mcp = await connect(settings, {
      llm: { json: async () => ({ action: 'finish', query: null, categories: null, indexerIds: null, status: 'no-match', options: null, message: '' }) } as unknown as NonNullable<SearchRuntimeOptions['llm']>,
      clients: () => ({ prowlarr: { getIndexers: async () => [{ id: 1, name: 'Index', enable: true }], getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [], grab: async () => { throw new Error('must not grab'); } } }),
    });
    const decode = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((result.content as Array<{text:string}>)[0]!.text);
    const started = decode(await mcp.callTool({ name: 'ma_search_v2', arguments: { prompt: 'Find Example' } }));
    await runtime!.drain();
    expect(decode(await mcp.callTool({ name: 'ma_search_status_v2', arguments: { searchId: started.searchId } }))).toMatchObject({ status: 'no-match' });
    runtime!.store.createSearch({ searchId: 'old-match', prompt: '{"prompt":"Old"}', status: 'matched', createdAt: Date.now() - 1_900_000, finishedAt: Date.now() - 1_900_000, result: { options: [{ optionId: 'old', releases: [{ candidateId: 'c' }] }] } });
    expect(decode(await mcp.callTool({ name: 'ma_submit_v2', arguments: { searchId: 'old-match', optionId: 'old', idempotencyKey: 'expired' } }))).toMatchObject({ outcome: 'expired' });
    expect(decode(await mcp.callTool({ name: 'ma_activity_v2', arguments: { status: 'expired' } }))).toMatchObject({ total: 1, items: [{ submission: { outcome: 'expired' } }] });
  });
  it('exposes only the search-first tools, and unknown status lookup is a stored safe 404', async () => {
    const mcp = await connect();
    const tools = await mcp.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual(['ma_activity_v2','ma_automation_poll_v2','ma_automation_search_v2','ma_automation_status_v2','ma_download_clients_v2','ma_search_status_v2','ma_search_v2','ma_status','ma_submit_v2'].sort());
    const result = await mcp.callTool({ name: 'ma_search_status_v2', arguments: { searchId: 'missing-id' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('404');
  });

  it('reports readiness without making upstream calls and bounds activity inputs', async () => {
    const mcp = await connect();
    const status = await mcp.callTool({ name: 'ma_status', arguments: {} });
    expect(status.isError).not.toBe(true);
    const invalid = await mcp.callTool({ name: 'ma_activity_v2', arguments: { limit: 101, offset: 0 } });
    expect(invalid.isError).toBe(true);
  });

  it('marks only explicit submit and automation poll destructive', async () => {
    const tools = (await (await connect()).listTools()).tools;
    expect(tools.find(t => t.name === 'ma_submit_v2')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find(t => t.name === 'ma_automation_poll_v2')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find(t => t.name === 'ma_search_v2')?.annotations?.readOnlyHint).toBe(true);
  });
});
