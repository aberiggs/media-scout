import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStack, type Stack } from './compose';
import { loadConfig } from './config';
import { searchRequestSchema, submissionRequestSchema, activityStatusSchema } from './search/contracts';
import { missingSettings, type Settings } from './settings';

declare module 'fastify' { interface FastifyInstance { refreshScheduler?: () => void } }
const identifier = z.string().trim().min(1).max(200);
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(1_000_000).default(0), q: z.string().max(200).optional(), status: activityStatusSchema.optional(), source: z.enum(['manual', 'automation']).optional(), kind: z.enum(['tv', 'movie', 'other']).optional(), createdAtFrom: z.string().max(40).datetime({ offset: true }).optional(), createdAtTo: z.string().max(40).datetime({ offset: true }).optional() }).strict().refine(q => !q.createdAtFrom || !q.createdAtTo || Date.parse(q.createdAtFrom) <= Date.parse(q.createdAtTo), { message: 'createdAtFrom must be on or before createdAtTo' });
function mutationAllowed(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (typeof request.headers.origin === 'string') {
    try { return new URL(request.headers.origin).host.toLowerCase() === String(request.headers.host).toLowerCase(); } catch { return false; }
  }
  return true;
}

export async function buildApp(stack: Stack, options: { webRoot?: string } = {}) {
  const { runtime } = stack;
  const app = Fastify({ loggerInstance: stack.logger.child({ component: 'daemon' }), bodyLimit: 1_048_576, logController: new LogController({ disableRequestLogging: true }) });
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
  app.get('/api/settings', async () => envelope());
  app.put('/api/settings', async (request, reply) => {
    const saved = runtime.saveSettings(request.body);
    if (!saved.ok) return reply.code(400).send({ error: 'Invalid settings', issues: saved.issues });
    app.refreshScheduler?.();
    return envelope();
  });
  app.post('/api/v2/searches', async (request, reply) => reply.code(202).send(runtime.startSearch(searchRequestSchema.parse(request.body))));
  app.get('/api/v2/searches/:id', async (request, reply) => {
    const value = await runtime.getSearch(identifier.parse((request.params as { id: string }).id));
    return value ?? reply.code(404).send({ error: 'Search not found' });
  });
  app.get('/api/v2/activity', async request => {
    const raw = Object.fromEntries(Object.entries(request.query as Record<string, unknown>).filter(([, value]) => value !== ''));
    return runtime.activity(activityQuery.parse(raw));
  });
  app.get('/api/v2/download-clients', async () => ({ items: await runtime.downloadClients() }));
  app.post('/api/v2/submissions', async request => runtime.submit(submissionRequestSchema.parse(request.body)));
  app.get('/api/v2/submissions/:id', async (request, reply) => {
    const receipt = runtime.store.getSubmission(identifier.parse((request.params as { id: string }).id));
    if (!receipt) return reply.code(404).send({ error: 'Submission not found' });
    const payload = receipt.payload as { request?: { searchId: string; optionId: string }; result?: unknown };
    return payload.result ?? { searchId: payload.request?.searchId, optionId: payload.request?.optionId, outcome: receipt.outcome === 'submitting' ? 'uncertain' : receipt.outcome };
  });
  app.get('/api/v2/automation', async () => runtime.automationStatus());
  app.post('/api/v2/automation/poll', async () => runtime.poll());
  app.post('/api/v2/automation/search', async (request, reply) => {
    const body = z.object({ targetId: identifier }).strict().parse(request.body);
    return reply.code(202).send(await runtime.startArrSearch(body.targetId));
  });
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
    try { await stack.runtime.poll(); } catch { stack.logger.warn({ code: 'poll-unavailable' }, 'scheduled poll failed'); }
  });
  app.refreshScheduler = scheduler.refresh;
  scheduler.refresh();
  const shutdown = createShutdown({ stopTimer: scheduler.stop, quiesce: () => stack.runtime.quiesce(), awaitSettled: () => stack.runtime.drain(), close: async () => { await app.close(); await stack.runtime.close(); }, exit: code => process.exit(code) });
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

export function createMonitorScheduler(getSettings: () => Settings, run: () => Promise<void>, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }): { refresh(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const refresh = () => {
    if (timer) timers.clear(timer);
    timer = undefined;
    const settings = getSettings();
    if (stopped || !settings.monitoring.enabled) return;
    timer = timers.set(() => { timer = undefined; if (!getSettings().monitoring.enabled) { refresh(); return; } void run().catch(() => undefined).finally(refresh); }, settings.monitoring.intervalMinutes * 60_000);
  };
  return { refresh, stop: () => { stopped = true; if (timer) timers.clear(timer); timer = undefined; } };
}
export function createShutdown(deps: { stopTimer(): void; quiesce?(): void; awaitSettled(): Promise<void>; close(): Promise<void>; exit(code: number): void }): (signal: string) => void {
  let draining = false;
  return () => { if (draining) return; draining = true; deps.stopTimer(); deps.quiesce?.(); void (async () => { await deps.awaitSettled(); await deps.close(); deps.exit(0); })(); };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startDaemon(buildStack({ config: loadConfig() })).catch(() => { console.error('Media Scout startup failed; check configuration and use a fresh database path.'); process.exitCode = 1; });
