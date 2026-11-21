import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/daemon';
import { SearchRuntime } from '../src/search/runtime';
import { defaultSettings } from '../src/search/settings';
import { openSearchStore } from '../src/search/store';
import pino from 'pino';
import type { Stack } from '../src/compose';
import { createSearchMcpServer } from '../src/search/mcp';
import { createHttpSearchDomain, daemonOrigin } from '../src/mcp/http-domain';

describe('stdio-to-daemon HTTP MCP domain', () => {
  it('does not expose a malformed daemon response body', async () => {
    const domain = createHttpSearchDomain('http://daemon.test', async () => new Response('PRIVATE_BODY_CANARY', { status: 200 }));
    await expect(domain.getSearch('search')).rejects.toThrow('Operation failed');
  });
  let app: ReturnType<typeof Fastify> | undefined;
  let mcp: Awaited<ReturnType<typeof createSearchMcpServer>> | undefined;
  let client: Client | undefined;
  afterEach(async () => { await client?.close(); await mcp?.close(); await app?.close(); client = undefined; mcp = undefined; app = undefined; });

  it('forwards status and queued search through the daemon API with no local engine', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    app = Fastify();
    app.get('/api/v2/status', async () => ({ ready: false, missing: ['ai.apiKey'], enabled: false, dryRun: true, running: false, executionBlocked: true, executionBlockedReason: 'execution-deferred', providers: [], items: [] }));
    app.get('/api/v2/automation', async () => ({ enabled: false, dryRun: true, running: false, executionBlocked: true, executionBlockedReason: 'execution-deferred', providers: [], items: [] }));
    app.post('/api/v2/searches', async (request: FastifyRequest, reply: FastifyReply) => { calls.push({ url: request.url, method: request.method, body: request.body }); return reply.code(202).send({ searchId: 'queued-by-daemon', status: 'queued' }); });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const { InMemoryTransport } = await import('@modelcontextprotocol/client');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcp = createSearchMcpServer(createHttpSearchDomain(`http://127.0.0.1:${address.port}`));
    await Promise.all([mcp.connect(serverTransport), clientTransport.start()]);
    client = new Client({ name: 'http-adapter-test', version: '1.0.0' });
    await client.connect(clientTransport);
    const status = await client.callTool({ name: 'ma_status', arguments: {} });
    expect(JSON.stringify(status)).toContain('ai.apiKey');
    const result = await client.callTool({ name: 'ma_search_v2', arguments: { prompt: 'synthetic search' } });
    expect(JSON.stringify(result)).toContain('queued-by-daemon');
    expect(calls).toEqual([{ url: '/api/v2/searches', method: 'POST', body: { prompt: 'synthetic search' } }]);
    expect(daemonOrigin('0.0.0.0', 7877)).toBe('http://127.0.0.1:7877');
    expect(daemonOrigin('::', 7877)).toBe('http://127.0.0.1:7877');
  });

  it('serves stdio MCP over an existing daemon, queues there with incomplete settings, and opens no local database', async () => {
    const dbPath = join(tmpdir(), `stdio-mcp-must-not-open-${randomUUID()}.db`);
    const runtime = new SearchRuntime({ store: openSearchStore(':memory:'), initialSettings: defaultSettings });
    app = await buildApp({ runtime, config: { HTTP_HOST: '127.0.0.1', HTTP_PORT: 7877, DB_PATH: dbPath, LOG_LEVEL: 'silent' }, logger: pino({ level: 'silent' }) } as unknown as Stack, { webRoot: '/missing' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing daemon listener');
    const port = address.port;
    expect((await app.inject({ method: 'POST', url: '/api/v2/automation/search', payload: { targetId: 'gone' } })).statusCode).toBe(404);
    for (const field of ['context', 'preferences', 'arrTargetIds', 'preferredDownloadClientId', 'notAContractField']) {
      expect((await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'valid', [field]: 'legacy' } })).statusCode).toBe(400);
    }
    // The daemon config's DB_PATH is deliberately nonexistent. The stdio child receives only
    // the origin settings, so only the in-memory daemon store can receive this queued search.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['node_modules/tsx/dist/cli.mjs', 'src/mcp/server.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HTTP_HOST: '127.0.0.1', HTTP_PORT: String(port), DB_PATH: dbPath },
    });
    client = new Client({ name: 'stdio-integration-test', version: '1.0.0' });
    await client.connect(transport);
    const status = await client.callTool({ name: 'ma_status', arguments: {} });
    expect(JSON.stringify(status)).toContain('ai.apiKey');
     const removedTool = await client.listTools();
     expect(removedTool.tools.map(tool => tool.name)).not.toContain('ma_automation_search_v2');
     for (const field of ['context', 'preferences', 'arrTargetIds', 'preferredDownloadClientId', 'notAContractField']) {
       const rejected = await client.callTool({ name: 'ma_search_v2', arguments: { prompt: 'legacy', [field]: 'legacy' } });
       expect(rejected.isError).toBe(true);
     }
     const prompt = '  queued with incomplete settings\nsecond line  ';
     const search = await client.callTool({ name: 'ma_search_v2', arguments: { prompt } });
    const text = (search.content as Array<{ text: string }>)[0]!.text;
    const { searchId } = JSON.parse(text) as { searchId: string; status: string };
     expect(JSON.parse(text).status).toBe('queued');
     expect((await runtime.getSearch(searchId))?.prompt).toBe(prompt);
     const jsonPrompt = '{"version":1,"request":{"prompt":"this is literal user text"}}';
     const jsonSearch = await client.callTool({ name: 'ma_search_v2', arguments: { prompt: jsonPrompt } });
     const jsonSearchId = JSON.parse((jsonSearch.content as Array<{ text: string }>)[0]!.text).searchId as string;
     expect((await runtime.getSearch(jsonSearchId))?.prompt).toBe(jsonPrompt);
     const history = await client.callTool({ name: 'ma_activity_v2', arguments: { q: 'queued with incomplete settings', status: 'queued' } });
      expect(JSON.parse((history.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
        total: 1, items: [{ searchId, status: 'queued', prompt }],
      });
    expect(existsSync(dbPath)).toBe(false);
    await transport.close();
    client = undefined;
    await app.close();
    app = undefined;
    await runtime.close();
  });
});
