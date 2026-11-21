import Fastify, { LogController, type FastifyRequest, type FastifyReply } from 'fastify';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStack, type Stack } from './compose';
import { loadConfig } from './config';
import { searchRequestSchema, activityStatusSchema } from './search/contracts';
import { missingSettings, type Settings } from './settings';
import { createProwlarrMcpServer } from './search/prowlarr-mcp';
import { LEGACY_DATABASE_ERROR } from './search/store';
import { deleteResearchServer, listResearchServers, saveResearchServer } from './search/research-mcp';

declare module 'fastify' { interface FastifyInstance { refreshScheduler?: () => void } }
const identifier = z.string().trim().min(1).max(200);
const prepareExecutionSchema=z.object({searchId:identifier,planId:identifier,version:z.number().int().positive(),candidateIds:z.array(identifier).min(1).max(100),downloadClientId:z.number().int().positive()}).strict();
const commitExecutionSchema=z.object({confirmationId:identifier,searchId:identifier,planId:identifier,version:z.number().int().positive(),idempotencyKey:identifier}).strict();
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(1_000_000).default(0), q: z.string().max(200).optional(), status: activityStatusSchema.optional(), source: z.enum(['manual', 'automation', 'arr']).optional(), kind: z.enum(['tv', 'movie', 'other']).optional(), createdAtFrom: z.string().max(40).datetime({ offset: true }).optional(), createdAtTo: z.string().max(40).datetime({ offset: true }).optional() }).strict().refine(q => !q.createdAtFrom || !q.createdAtTo || Date.parse(q.createdAtFrom) <= Date.parse(q.createdAtTo), { message: 'createdAtFrom must be on or before createdAtTo' });
function mutationAllowed(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (typeof request.headers.origin === 'string') {
    try { return new URL(request.headers.origin).host.toLowerCase() === String(request.headers.host).toLowerCase(); } catch { return false; }
  }
  return true;
}
function publicExecutionError(error:unknown):{code:string;message:string;action:string} {
  const raw=error instanceof Error?error.message:'execution-unavailable';
  const known=new Set(['plan-unavailable','plan-changed','whole-plan-selection-required','dry-run-enabled','search-source-not-manual','prowlarr-source-unavailable','source-changed','candidate-not-selected','candidate-expired','candidate-source-unverified','invalid-candidate-set','download-client-unavailable','download-client-protocol-mismatch','grab-adapter-unavailable','invalid-idempotency-key','confirmation-expired','safety-changed','client-changed','idempotency-conflict','physical-release-busy','execution-ownership-lost']);
  const code=known.has(raw)?raw:'execution-unavailable';
  const message=code==='physical-release-busy'?'A selected release is temporarily reserved; inspect its receipt or retry after the hold expires.'
    :code==='idempotency-conflict'?'This idempotency key is already bound to a different confirmation; use a new key after checking the receipt.'
    :['source-changed','client-changed','safety-changed','plan-changed','candidate-expired','candidate-source-unverified','confirmation-expired'].includes(code)?'The source, plan, candidate, client, or safety settings changed; review current search details and confirm again.'
    :code==='execution-unavailable'?'Execution is unavailable; review the current search and configuration.':'Review the selected plan and current client configuration, then prepare a new confirmation.';
  return {code,message,action:code==='physical-release-busy'?'retry-later':code==='idempotency-conflict'?'new-idempotency-key':'reconfirm'};
}

export async function buildApp(stack: Stack, options: { webRoot?: string } = {}) {
  const { runtime } = stack;
  const app = Fastify({ loggerInstance: stack.logger.child({ component: 'daemon' }), bodyLimit: 1_048_576, logController: new LogController({ disableRequestLogging: true }) });
  app.server.once('listening', () => {
    const address = app.server.address();
    if (address && typeof address !== 'string') {
      const host = address.address === '::' ? '::1' : address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
      runtime.setInternalMcpUrl(`http://${host.includes(':') ? `[${host}]` : host}:${address.port}/internal/mcp/prowlarr`);
    }
  });
  type ProwlarrSession = { token: string; transport: NodeStreamableHTTPServerTransport; responses: Set<Promise<void>> };
  const prowlarrSessions = new Map<string, ProwlarrSession>();
  const serveProwlarrSession = async (session: ProwlarrSession, request: FastifyRequest, reply: FastifyReply) => {
    // A closed SSE response is not a terminal tool result to legacy clients.
    // Drain POST responses before closing the SDK transport; long-lived GET
    // event streams must instead be closed by the transport itself.
    if (request.method === 'POST') {
      let finish!: () => void;
      const response = new Promise<void>(resolve => { finish = resolve; });
      session.responses.add(response);
      const done = () => {
        reply.raw.off('finish', done);
        reply.raw.off('close', done);
        session.responses.delete(response);
        finish();
      };
      reply.raw.once('finish', done);
      reply.raw.once('close', done);
    }
    return session.transport.handleRequest(request.raw, reply.raw, request.body);
  };
  app.addHook('preClose', async () => {
    runtime.quiesce();
    await runtime.drain();
    await runtime.closeProwlarrMcpSessions();
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !mutationAllowed(request)) return reply.code(403).send({ error: 'Cross-origin mutation rejected', code: 'origin-rejected' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const invalid = error instanceof z.ZodError;
    app.log.warn({ code: invalid ? 'invalid-request' : 'operation-unavailable' }, 'request failed');
    return reply.code(invalid ? 400 : 503).send({ error: invalid ? 'Invalid request' : 'Operation unavailable; check configuration and current source status', code: invalid ? 'invalid-request' : 'operation-unavailable' });
  });
  const envelope = () => { const settings = runtime.getSettings(), missing = missingSettings(settings); return { settings, status: { ready: missing.length === 0, missing, monitoringEnabled: settings.monitoring.enabled, cycleRunning: runtime.automationStatus().running } }; };
  app.get('/health', async () => ({ status: 'ok', interfaceVersion: 2, dryRun: runtime.getSettings().safety.dryRun }));
  app.get('/api/v2/status', async () => {
    const missing = runtime.missingSettings();
    return { ready: missing.length === 0, missing, ...runtime.automationStatus() };
  });
  app.get('/api/settings', async () => envelope());
  app.get('/api/research-mcp', async () => ({ servers: listResearchServers(runtime.store) }));
  const researchInput = z.object({
    name: z.string().trim().min(1).max(100),
    url: z.string().min(1).max(2048), enabled: z.boolean(),
    credential: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('replace'), header: z.string().min(1).max(100), value: z.string().min(1).max(4096) }).strict(),
      z.object({ mode: z.literal('clear') }).strict(),
    ]).optional(),
  }).strict();
  const researchError = (error: unknown) => {
    if (error instanceof z.ZodError) return { code: 'invalid-request', error: 'Provide a valid server name, HTTP(S) URL, enabled flag, and credential.' };
    const errors: Record<string,string> = {
      'invalid-endpoint':'Use an HTTP(S) URL without credentials, query, or fragment.',
      'invalid-header':'The credential header is invalid or prohibited.',
      'invalid-credential':'The credential value is invalid.',
      'not-found':'Research MCP server not found.',
      'server-limit':'Remove an existing research server before adding another.',
      'research-auth-failed':'The MCP server rejected the connection. Check its credential and permissions.',
      'research-redirect-denied':'MCP redirects are not followed. Configure the final Streamable HTTP endpoint.',
      'research-settings-changed':'The saved connection changed while it was connecting. Review current settings and connect again.',
      'research-timeout':'The MCP server took too long to respond. Check its address or try again.',
      'research-metadata-endpoint-denied':'This address resolves to a blocked metadata or link-local network.',
      'research-endpoint-unavailable':'The endpoint hostname could not be resolved.',
      'research-no-usable-tools':'The server connected but exposed no supported tools.',
      'research-tool-limit':'The server exposes too many or too much tool metadata to connect safely.',
      'research-mcp-unavailable':'The MCP server could not be reached or returned an unsupported response.',
    };
    const code = error instanceof Error && Object.hasOwn(errors, error.message) ? error.message : 'research-mcp-unavailable';
    return { code, error: errors[code]! };
  };
  const researchErrorStatus = (code: string) => code === 'not-found' ? 404
    : code === 'research-settings-changed' ? 409
    : ['research-metadata-endpoint-denied','research-no-usable-tools','research-tool-limit'].includes(code) ? 422
      : ['research-auth-failed','research-redirect-denied','research-timeout','research-endpoint-unavailable','research-mcp-unavailable'].includes(code) ? 502 : 400;
  app.post('/api/research-mcp', async (request, reply) => {
    try { return reply.code(201).send(await saveResearchServer(runtime.store, undefined, researchInput.parse(request.body))); }
    catch (error) { const result = researchError(error); return reply.code(researchErrorStatus(result.code)).send(result); }
  });
  app.put('/api/research-mcp/:id', async (request, reply) => {
    try { return await saveResearchServer(runtime.store, identifier.parse((request.params as {id:string}).id), researchInput.parse(request.body)); }
    catch (error) { const result = researchError(error); return reply.code(researchErrorStatus(result.code)).send(result); }
  });
  app.delete('/api/research-mcp/:id', async (request, reply) => {
    if (!deleteResearchServer(runtime.store, identifier.parse((request.params as {id:string}).id))) return reply.code(404).send({ code: 'not-found', error: 'Research MCP server not found.' });
    return reply.code(204).send();
  });
  app.put('/api/settings', async (request, reply) => {
    const saved = runtime.saveSettings(request.body);
    if (!saved.ok) return reply.code(400).send({ error: 'Invalid settings', issues: saved.issues });
    app.refreshScheduler?.();
    return envelope();
  });
  app.post('/api/v2/searches', async (request, reply) => reply.code(202).send(await runtime.startSearch(searchRequestSchema.parse(request.body))));
  app.all('/internal/mcp/prowlarr', async (request, reply) => {
    const match = /^Bearer ([a-f\d]{64})$/i.exec(String(request.headers.authorization ?? ''));
    if (!match || !runtime.hasProwlarrMcpCapability(match[1]!)) return reply.code(401).send({ error: 'Unauthorized' });
    const token = match[1]!, sessionId = String(request.headers['mcp-session-id'] ?? '');
    if (sessionId) {
      const session = prowlarrSessions.get(sessionId);
      if (!session || session.token !== token || !runtime.hasProwlarrMcpSession(sessionId, token))
        return reply.code(404).send({ error: 'MCP session not found' });
      return serveProwlarrSession(session, request, reply);
    }
    if (request.method !== 'POST') return reply.code(400).send({ error: 'MCP session required' });
    const createdSessionId = randomUUID().replaceAll('-', '');
    const server = createProwlarrMcpServer(runtime, token);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => createdSessionId });
    const session: ProwlarrSession = { token, transport, responses: new Set() };
    prowlarrSessions.set(createdSessionId, session);
    if (!runtime.registerProwlarrMcpSession(createdSessionId, token, async () => {
      prowlarrSessions.delete(createdSessionId);
      await Promise.allSettled([...session.responses]);
      await server.close();
    })) {
      prowlarrSessions.delete(createdSessionId);
      await server.close();
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    transport.onclose = () => {
      prowlarrSessions.delete(createdSessionId);
      runtime.unregisterProwlarrMcpSession(createdSessionId);
    };
    try {
      await server.connect(transport);
      await serveProwlarrSession(session, request, reply);
      if (!transport.sessionId) {
        runtime.unregisterProwlarrMcpSession(createdSessionId);
        prowlarrSessions.delete(createdSessionId);
        await server.close();
      }
    } catch (error) {
      runtime.unregisterProwlarrMcpSession(createdSessionId);
      prowlarrSessions.delete(createdSessionId);
      await server.close();
      throw error;
    }
  });
  app.get('/api/v2/searches/:id', async (request, reply) => {
    const value = await runtime.getSearch(identifier.parse((request.params as { id: string }).id));
    return value ?? reply.code(404).send({ error: 'Search not found' });
  });
  app.get('/api/v2/activity', async request => {
    const raw = Object.fromEntries(Object.entries(request.query as Record<string, unknown>).filter(([, value]) => value !== ''));
    return runtime.activity(activityQuery.parse(raw));
  });
  app.get('/api/v2/download-clients', async () => ({ items: await runtime.downloadClients() }));
  app.post('/api/v2/executions/prepare', async (request,reply) => {
    try { return await runtime.prepareExecution(prepareExecutionSchema.parse(request.body)); }
    catch(error) { const failure=publicExecutionError(error); return reply.code(error instanceof z.ZodError?400:409).send({code:failure.code,error:failure.message,action:failure.action}); }
  });
  app.post('/api/v2/executions/commit', async (request,reply) => {
    try { return await runtime.commitExecution(commitExecutionSchema.parse(request.body)); }
    catch(error) { const failure=publicExecutionError(error); return reply.code(error instanceof z.ZodError?400:409).send({code:failure.code,error:failure.message,action:failure.action}); }
  });
  app.get('/api/v2/executions/:id', async (request,reply) => {
    const receipt=runtime.executionReceipt(identifier.parse((request.params as {id:string}).id));
    return receipt ?? reply.code(404).send({error:'Execution receipt not found',code:'receipt-not-found'});
  });
  app.post('/api/v2/submissions', async (_request, reply) => reply.code(410).send({ error: 'This endpoint was retired; use release-set execution', code: 'submission-route-retired' }));
  app.get('/api/v2/automation', async () => runtime.automationStatus());
  app.post('/api/v2/automation/poll', async () => runtime.poll());
  const webRoot = options.webRoot ?? resolve(process.cwd(), 'web/dist');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/cycle' || pathname.startsWith('/health') || !['GET', 'HEAD'].includes(request.method)) return reply.code(404).send({ error: 'Not found' });
      return reply.type('text/html').sendFile('index.html');
    });
  }
  return app;
}

export async function startDaemon(stack: Stack): Promise<void> {
  const app = await buildApp(stack);
  await app.listen({ host: stack.config.HTTP_HOST, port: stack.config.HTTP_PORT });
  const scheduler = createMonitorScheduler(() => stack.runtime.getSettings(), async () => {
    try { return await stack.runtime.runAutomation(); } catch { stack.logger.warn({ code: 'poll-unavailable' }, 'scheduled automation pass failed'); return undefined; }
  });
  app.refreshScheduler = scheduler.refresh;
  scheduler.refresh();
  const shutdown = createShutdown({ stopTimer: scheduler.stop, quiesce: () => stack.runtime.quiesce(), awaitSettled: () => stack.runtime.drain(), close: async () => { await app.close(); await stack.runtime.close(); }, exit: code => process.exit(code) });
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

export function createMonitorScheduler(getSettings: () => Settings, run: () => Promise<{ ran: boolean; nextAttemptAt?: number } | void>, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }): { refresh(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false, running = false;
  const schedule = (delay: number) => {
    if (stopped || running || !getSettings().monitoring.enabled) return;
    timer = timers.set(() => {
      timer = undefined;
      if (!getSettings().monitoring.enabled) { refresh(); return; }
      running = true;
      void run().catch(() => undefined).then(result => {
        running = false;
        if (!stopped && getSettings().monitoring.enabled) {
          const interval = getSettings().monitoring.intervalMinutes * 60_000;
          const untilDue = result?.nextAttemptAt === undefined ? interval : result.nextAttemptAt - Date.now();
          schedule(Math.max(1, Math.min(interval, untilDue)));
        }
      });
    }, delay);
  };
  const refresh = () => {
    if (timer) timers.clear(timer);
    timer = undefined;
    const settings = getSettings();
    if (stopped || running || !settings.monitoring.enabled) return;
    schedule(settings.monitoring.intervalMinutes * 60_000);
  };
  return { refresh, stop: () => { stopped = true; if (timer) timers.clear(timer); timer = undefined; } };
}
export function createShutdown(deps: { stopTimer(): void; quiesce?(): void; awaitSettled(): Promise<void>; close(): Promise<void>; exit(code: number): void }): (signal: string) => void {
  let draining = false;
  return () => { if (draining) return; draining = true; deps.stopTimer(); deps.quiesce?.(); void (async () => { await deps.awaitSettled(); await deps.close(); deps.exit(0); })(); };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void Promise.resolve().then(() => startDaemon(buildStack({ config: loadConfig() }))).catch((error: unknown) => {
    console.error(error instanceof Error && error.message === LEGACY_DATABASE_ERROR
      ? error.message : 'Media Scout startup failed; check configuration and DB_PATH.');
    process.exitCode = 1;
  });
}
