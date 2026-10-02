import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { buildStack, type Stack } from './compose';
import { loadConfig } from './config';
import { missingSettings, settingsSchema, type Settings } from './settings';
import type { CycleSummary } from './core/runner';

type CycleAttempt = { ok: true; summary: CycleSummary } | { ok: false; conflict: true } | { ok: false; error: unknown };
interface CycleGate { run(): Promise<CycleAttempt>; settled(): Promise<void>; isRunning(): boolean }
function createCycleGate(runCycle: () => Promise<CycleSummary>): CycleGate {
  let running = false;
  let inFlight: Promise<unknown> | null = null;
  return {
    async run() {
      if (running) return { ok: false, conflict: true };
      running = true;
      try { const cycle = runCycle(); inFlight = cycle; return { ok: true, summary: await cycle }; }
      catch (error) { return { ok: false, error }; }
      finally { running = false; inFlight = null; }
    },
    async settled() { await inFlight?.catch(() => {}); },
    isRunning: () => running,
  };
}
declare module 'fastify' {
  interface FastifyInstance { cycleGate: CycleGate; refreshScheduler?: () => void }
}

function envelope(settings: Settings, cycleRunning: boolean) {
  const missing = missingSettings(settings);
  return { settings, status: { ready: missing.length === 0, missing, monitoringEnabled: settings.monitoring.enabled, cycleRunning } };
}
function mutationAllowed(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  const fetchSiteHeader = request.headers['sec-fetch-site'];
  const fetchSite = Array.isArray(fetchSiteHeader) ? fetchSiteHeader[0] : fetchSiteHeader;
  if (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site') return false;
  const origin = request.headers.origin;
  if (typeof origin === 'string') {
    const hostHeader = request.headers.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    try { return !!host && new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
  }
  return true;
}

export async function buildApp(stack: Stack, options: { webRoot?: string } = {}): Promise<FastifyInstance> {
  // Fastify's default request serializer logs full URLs (including query strings).
  // These local settings routes carry secrets in bodies, so do not log request records.
  const app = Fastify({ loggerInstance: stack.logger.child({ component: 'daemon' }), logController: new LogController({ disableRequestLogging: true }) });
  const gate = createCycleGate(async () => {
    const settings = stack.state.getSettings();
    const missing = missingSettings(settings);
    if (missing.length) throw new Error('settings-incomplete');
    const runtime = stack.createSnapshot(settings);
    return runtime.runner.cycle();
  });
  app.decorate('cycleGate', gate);

  app.get('/health', async () => { const settings = stack.state.getSettings(); return { status: 'ok', dryRun: settings.safety.dryRun, model: settings.ai.model }; });
  app.get('/api/settings', async () => envelope(stack.state.getSettings(), gate.isRunning()));
  app.put('/api/settings', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected' });
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid settings', issues: parsed.error.issues.map(({ path, message, code }) => ({ path, message, code })) });
    stack.state.saveSettings(parsed.data);
    app.refreshScheduler?.();
    return envelope(parsed.data, gate.isRunning());
  });
  app.post('/cycle', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected' });
    const attempt = await gate.run();
    if (attempt.ok) return attempt.summary;
    if ('conflict' in attempt) return reply.code(409).send({ error: 'cycle already running' });
    app.log.error({ errorType: attempt.error instanceof Error ? attempt.error.name : 'UnknownError' }, 'cycle failed');
    return reply.code(503).send({ error: 'cycle unavailable; check settings and server logs' });
  });

  const webRoot = options.webRoot ?? resolve(process.cwd(), 'web/dist');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/cycle' || pathname.startsWith('/cycle/') || pathname === '/health' || pathname.startsWith('/health/')) return reply.code(404).send({ error: 'not found' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(404).send({ error: 'not found' });
      return reply.type('text/html').sendFile('index.html');
    });
  }
  return app as unknown as FastifyInstance;
}

export async function startDaemon(stack: Stack): Promise<void> {
  const app = await buildApp(stack);
  const logger: Logger = stack.logger.child({ component: 'daemon' });
  await app.listen({ port: stack.config.HTTP_PORT, host: stack.config.HTTP_HOST ?? '0.0.0.0' });

  const scheduler = createMonitorScheduler(() => stack.state.getSettings(), async () => {
    const attempt = await app.cycleGate.run();
    if (attempt.ok) logger.info(attempt.summary, 'scheduled cycle finished');
    else if ('conflict' in attempt) logger.info('skipped: cycle already in progress');
    else logger.error({ errorType: attempt.error instanceof Error ? attempt.error.name : 'UnknownError' }, 'scheduled cycle failed');
  });
  app.refreshScheduler = scheduler.refresh;
  scheduler.refresh();
  const drain = createShutdown({ stopTimer: scheduler.stop, awaitSettled: () => app.cycleGate.settled(), close: () => app.close(), exit: (code) => process.exit(code) });
  process.on('SIGINT', () => drain('SIGINT'));
  process.on('SIGTERM', () => drain('SIGTERM'));
}

export function createMonitorScheduler(
  getSettings: () => Settings,
  run: () => Promise<void>,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
): { refresh: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const refresh = () => {
    if (timer) timers.clear(timer);
    timer = undefined;
    const settings = getSettings();
    if (stopped || !settings.monitoring.enabled) return;
    timer = timers.set(() => {
      timer = undefined;
      if (!getSettings().monitoring.enabled) { refresh(); return; }
      void run().finally(refresh);
    }, settings.monitoring.intervalMinutes * 60_000);
  };
  const stop = () => { stopped = true; if (timer) timers.clear(timer); timer = undefined; };
  return { refresh, stop };
}

interface ShutdownDeps { stopTimer: () => void; awaitSettled: () => Promise<void>; close: () => Promise<void>; exit: (code: number) => void }
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  let draining = false;
  return (_signal: string) => { if (draining) return; draining = true; void (async () => { deps.stopTimer(); await deps.awaitSettled(); await deps.close(); deps.exit(0); })(); };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const stack = buildStack({ config });
  startDaemon(stack).catch((error: unknown) => { console.error(error instanceof Error ? error.name : 'StartupError'); process.exitCode = 1; });
}
