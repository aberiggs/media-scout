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
import { OperationsDashboard } from './core/operations';
import type { WorkAction } from './core/state';
import { z } from 'zod';

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
  const operations = new OperationsDashboard(stack.state);

  app.post('/api/search', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected', code: 'origin-rejected' });
    const body = z.object({ query: z.string().trim().min(1).max(500) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid search request', code: 'invalid-request' });
    try { return await stack.createSnapshot(stack.state.getSettings()).generalSearch.search(body.data); }
    catch (error) { const code = safeGeneralErrorCode(error); const status = code === 'invalid-request' ? 400 : code === 'search-unavailable' ? 503 : 502; return reply.code(status).send({ error: 'general search unavailable', code }); }
  });
  app.post('/api/search/conversation', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected', code: 'origin-rejected' });
    try { return await stack.createSnapshot(stack.state.getSettings()).generalSearchConversation.search(request.body as never); }
    catch (error) { const code = safeGeneralErrorCode(error); const status = code === 'invalid-request' ? 400 : code === 'search-unavailable' ? 503 : 502; return reply.code(status).send({ error: 'general search unavailable', code }); }
  });
  app.post('/api/search/conversation/stream', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected', code: 'origin-rejected' });
    const controller = new AbortController();
    let terminalEvent = false;
    let sequence = 0;
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) controller.abort(); });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const writeEvent = (event: Record<string, unknown>): void => {
      if (terminalEvent || controller.signal.aborted || reply.raw.destroyed) return;
      const type = event.type;
      if (!['planning','queries','searching','results','curation','complete','error'].includes(String(type))) return;
      const terminal = type === 'complete' || type === 'error';
      const output = type === 'error'
        ? { type: 'error', sequence: sequence++, code: safeGeneralErrorCode({ code: event.code }), message: safeGeneralErrorCode({ code: event.code }) }
        : { ...event, sequence: sequence++ };
      if (terminal) terminalEvent = true;
      reply.raw.write(`${JSON.stringify(output)}\n`);
    };
    const writeFallbackError = (error: unknown): void => {
      const code = safeGeneralErrorCode(error);
      writeEvent({ type: 'error', code, message: code });
    };
    try {
      await stack.createSnapshot(stack.state.getSettings()).generalSearchConversation.search(request.body as never, writeEvent, controller.signal);
      if (!terminalEvent) writeFallbackError({ code: 'operation-failed' });
    } catch (error) {
      if (!terminalEvent) writeFallbackError(error);
    } finally {
      if (!controller.signal.aborted && !reply.raw.destroyed) reply.raw.end();
    }
  });
  app.post('/api/search/:id/operations', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected', code: 'origin-rejected' });
    try { return await stack.createSnapshot(stack.state.getSettings()).generalSearch.createOperation((request.params as { id: string }).id, request.body); }
    catch (error) { const code = safeGeneralErrorCode(error); return reply.code(code === 'invalid-request' ? 400 : code === 'search-expired' ? 404 : 409).send({ error: 'operation unavailable', code }); }
  });
  app.get('/api/general-operations/:id', async (request, reply) => {
    try { return await stack.createSnapshot(stack.state.getSettings()).generalSearch.operationStatus((request.params as { id: string }).id); }
    catch (error) { const code = safeGeneralErrorCode(error); return reply.code(code === 'search-expired' || code === 'operation-not-found' ? 404 : 400).send({ error: 'operation unavailable', code }); }
  });
  app.post('/api/general-operations/:id/step', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected', code: 'origin-rejected' });
    const body = request.body as { expectedOrdinal?: unknown } | null;
    if (!body || !Number.isSafeInteger(body.expectedOrdinal) || (body.expectedOrdinal as number) < 0) return reply.code(400).send({ error: 'invalid operation step', code: 'invalid-request' });
    try { return await stack.createSnapshot(stack.state.getSettings()).generalSearch.stepOperation((request.params as { id: string }).id, request.body, body.expectedOrdinal as number); }
    catch (error) { const code = safeGeneralErrorCode(error); return reply.code(code === 'search-expired' ? 404 : code === 'invalid-request' ? 400 : 409).send({ error: 'operation unavailable', code }); }
  });
  app.post('/api/general-operations/:id/stop', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected', code: 'origin-rejected' });
    try { return { operation: await stack.createSnapshot(stack.state.getSettings()).generalSearch.stopOperation((request.params as { id: string }).id) }; }
    catch (error) { const code = safeGeneralErrorCode(error); return reply.code(code === 'search-expired' ? 404 : 409).send({ error: 'operation unavailable', code }); }
  });
  app.post('/api/search/:id/grab', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected', code: 'origin-rejected' });
    const id = (request.params as { id?: string }).id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: 'invalid search id', code: 'invalid-request' });
    const body = z.object({ confirmationToken: z.string().min(32).max(256), releaseIds: z.array(z.string().uuid()).min(1).max(1000), confirmed: z.literal(true) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid grab request', code: 'invalid-request' });
    try { return await stack.createSnapshot(stack.state.getSettings()).generalSearch.grab(id, body.data); }
    catch (error) { const code = safeGeneralErrorCode(error); const status = code === 'invalid-request' ? 400 : code === 'operator-actions-disabled' ? 403 : code === 'search-expired' ? 404 : code === 'invalid-confirmation' || code === 'invalid-release-selection' ? 400 : 409; return reply.code(status).send({ error: 'general grab unavailable', code }); }
  });

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

  app.get('/api/operations/work', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const page = parsePage(query);
    if (!page) return reply.code(400).send({ error: 'invalid query parameters', code: 'invalid-query' });
    const status = query.status === '' ? undefined : query.status;
    if (status !== undefined && (typeof status !== 'string' || !['ready','waiting-release','searching','cooldown','backoff','manual','fulfilled','inactive'].includes(status))) return reply.code(400).send({ error: 'invalid status filter', code: 'invalid-query' });
    const scope = query.scope === '' ? undefined : query.scope;
    if (scope !== undefined && (scope !== 'active' && scope !== 'all')) return reply.code(400).send({ error: 'invalid scope filter', code: 'invalid-query' });
    const q = parseSearch(query.q);
    if (q === null) return reply.code(400).send({ error: 'invalid search filter', code: 'invalid-query' });
    const settings = stack.state.getSettings();
    const now = new Date();
    return operations.work({ ...page, ...(typeof status === 'string' ? { status } : {}), ...(typeof scope === 'string' ? { scope } : {}), ...(q ? { q } : {}) }, settings.safety.allowOperatorActions, now);
  });
  app.get('/api/operations/reviews', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const page = parsePage(query);
    if (!page) return reply.code(400).send({ error: 'invalid query parameters', code: 'invalid-query' });
    const resolved = query.resolved === undefined ? false : query.resolved === 'true' ? true : query.resolved === 'false' ? false : null;
    if (resolved === null) return reply.code(400).send({ error: 'invalid resolved filter', code: 'invalid-query' });
    const q = parseSearch(query.q);
    if (q === null) return reply.code(400).send({ error: 'invalid search filter', code: 'invalid-query' });
    const settings = stack.state.getSettings();
    return operations.reviews({ ...page, resolved, ...(q ? { q } : {}) }, settings.safety.allowOperatorActions, new Date());
  });
  app.get('/api/operations/activity', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const page = parsePage(query);
    if (!page) return reply.code(400).send({ error: 'invalid query parameters', code: 'invalid-query' });
    const q = parseSearch(query.q);
    if (q === null) return reply.code(400).send({ error: 'invalid search filter', code: 'invalid-query' });
    const outcome = query.outcome === '' ? undefined : query.outcome;
    if (outcome !== undefined && (typeof outcome !== 'string' || !['running','success','error'].includes(outcome))) return reply.code(400).send({ error: 'invalid outcome filter', code: 'invalid-query' });
    const now = new Date().toISOString();
    const items = stack.state.listSearchActivity(now).filter((item) => (!q || `${item.query} ${item.media.map(({ title, workKey }) => `${title} ${workKey}`).join(' ')}`.toLocaleLowerCase().includes(q.toLocaleLowerCase())) && (!outcome || item.outcome === outcome));
    return { items: items.slice(page.offset, page.offset + page.limit), total: items.length, generatedAt: now, retention: { days: 7, maxEntries: 2000 } };
  });
  app.post('/api/operations/work/action', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected', code: 'origin-rejected' });
    if (gate.isRunning()) return reply.code(409).send({ error: 'cycle is running; try again after it settles', code: 'cycle-running' });
    const body = request.body as Record<string, unknown> | null;
    if (!body || Object.keys(body).some((key) => !['workKey','action'].includes(key)) || typeof body.workKey !== 'string' || !body.workKey || body.workKey.length > 160 || (body.action !== 'retry' && body.action !== 'reset')) return reply.code(400).send({ error: 'invalid work action request', code: 'invalid-request' });
    if (!stack.state.getSettings().safety.allowOperatorActions) return reply.code(403).send({ error: 'operator actions are disabled', code: 'operator-actions-disabled' });
    const action = body.action as WorkAction;
    const work = stack.state.getWorkItem(body.workKey);
    if (!work) return reply.code(404).send({ error: 'work item not found', code: 'work-not-found' });
    const claimKeys = [work.workKey, ...(work.unit.kind === 'tv' ? [`group:sonarr:${work.unit.serviceId}`, ...stack.state.listWorkItems().filter((candidate) => candidate.unit.kind === 'tv' && candidate.unit.serviceId === work.unit.serviceId).map(({ workKey }) => workKey)] : [])];
    const lease = stack.state.claimUnits({ keys: claimKeys, now: new Date() });
    if (!lease) return reply.code(409).send({ error: 'work is currently in flight or held', code: 'work-claimed' });
    try {
      stack.state.applyWorkAction({ workKey: work.workKey, action, ownerToken: lease.ownerToken, claimKeys: lease.keys, now: new Date().toISOString() });
      return { ok: true, message: action === 'retry' ? 'Retry is eligible for a later processing pass.' : 'Reset recorded; rediscovery will begin after a later known library observation.' };
    } catch {
      return reply.code(409).send({ error: 'work is not eligible for this action', code: 'action-not-eligible' });
    } finally {
      try { stack.state.releaseClaims({ keys: lease.keys, ownerToken: lease.ownerToken }); } catch { /* Owner checked cleanup cannot release a successor. */ }
    }
  });
  app.post('/api/operations/reviews/:id/prepare', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected', code: 'origin-rejected' });
    const id = parseReviewId((request.params as { id?: string }).id);
    const body = request.body as Record<string, unknown> | null;
    if (!id || !body || Object.keys(body).some((key) => key !== 'action') || (body.action !== 'associate' && body.action !== 'release')) return reply.code(400).send({ error: 'invalid prepare request', code: 'invalid-request' });
    const settings = stack.state.getSettings();
    if (!settings.safety.allowOperatorActions) return reply.code(403).send({ error: 'operator actions are disabled', code: 'operator-actions-disabled' });
    const runtime = stack.createSnapshot(settings);
    try {
      const operation = body.action === 'associate' ? 'associate_queue' : 'release_intent_hold';
      const prepared = await runtime.operatorActions.prepareReviewAction({ reviewId: id, operation });
      const review = stack.state.listManualReview(false).find(({ id: reviewId }) => reviewId === id);
      const targets = prepared.associationChoices?.targets ?? [];
      const choices = targets.map(({ index, title }) => ({ workKey: review?.workKey ?? '', title: safePublicTitle(title), targetIndex: index }));
      return {
        token: prepared.token, challenge: prepared.challenge, expiresAt: prepared.expiresAt,
        summary: body.action === 'associate' ? 'Review the current queue and library evidence before associating.' : 'Inspect all relevant download clients, including the original routing used at submission, before releasing this reservation.',
        targetNames: prepared.targetNames.map(safePublicTitle),
        queuePreview: prepared.queuePreview ? {
          title: safePublicTitle(prepared.queuePreview.title ?? '') || 'unknown',
          status: safePublicStatus(prepared.queuePreview.status),
        } : null,
        choices: choices.map(({ workKey, title }) => ({ workKey, title })),
        ...(prepared.associationChoices ? {
          mediaChoices: prepared.associationChoices.media.map(({ index, title }) => ({ mediaIndex: index, title: safePublicTitle(title) })),
          targetChoices: choices,
        } : {}),
        requiresClientInspection: body.action === 'release',
      };
    } catch {
      return reply.code(409).send({ error: 'review action could not be prepared from current evidence', code: 'prepare-unavailable' });
    }
  });
  app.post('/api/operations/reviews/:id/commit', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected', code: 'origin-rejected' });
    const id = parseReviewId((request.params as { id?: string }).id);
    const body = request.body as Record<string, unknown> | null;
    const allowedFields = ['action','token','challenge','note','workKey','clientInspectionConfirmed','mediaIndex','targetIndices'];
    if (!id || !body || Object.keys(body).some((key) => !allowedFields.includes(key)) || (body.action !== 'associate' && body.action !== 'release') || typeof body.token !== 'string' || body.token.length < 32 || typeof body.challenge !== 'string' || !body.challenge || typeof body.note !== 'string' || body.note.length < 3 || body.note.length > 500) return reply.code(400).send({ error: 'invalid commit request', code: 'invalid-request' });
    if (body.workKey !== undefined && (typeof body.workKey !== 'string' || !body.workKey || body.workKey.length > 160)) return reply.code(400).send({ error: 'invalid work target', code: 'invalid-request' });
    if (body.action === 'associate' && (!Number.isSafeInteger(body.mediaIndex) || (body.mediaIndex as number) < 0 || !Array.isArray(body.targetIndices) || body.targetIndices.length < 1 || !body.targetIndices.every((index) => Number.isSafeInteger(index) && (index as number) >= 0))) return reply.code(400).send({ error: 'association selection is required', code: 'invalid-request' });
    if (body.action === 'release' && (body.mediaIndex !== undefined || body.targetIndices !== undefined)) return reply.code(400).send({ error: 'release selection is invalid', code: 'invalid-request' });
    if (body.action === 'release' && body.clientInspectionConfirmed !== true) return reply.code(400).send({ error: 'download client inspection confirmation is required', code: 'inspection-required' });
    const settings = stack.state.getSettings();
    if (!settings.safety.allowOperatorActions) return reply.code(403).send({ error: 'operator actions are disabled', code: 'operator-actions-disabled' });
    const runtime = stack.createSnapshot(settings);
    try {
      if (body.action === 'associate') {
        const review = stack.state.listManualReview(false).find(({ id: reviewId }) => reviewId === id);
        if (!review || (body.workKey !== undefined && body.workKey !== review.workKey)) throw new Error('invalid target');
        await runtime.operatorActions.associateQueue({ reviewId: id, token: body.token, proposedAssociation: { mediaIndex: body.mediaIndex as number, targetIndices: body.targetIndices as number[] }, challengeResponse: body.challenge, note: body.note });
      } else await runtime.operatorActions.releaseIntentHold({ reviewId: id, token: body.token, challengeResponse: body.challenge, note: body.note });
      return { ok: true, message: body.action === 'associate' ? 'Queue association recorded.' : 'Reservation released.' };
    } catch {
      return reply.code(409).send({ error: 'review action could not be committed; prepare again using current evidence', code: 'commit-unavailable' });
    }
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

function safeGeneralErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error && typeof (error as {code?:unknown}).code === 'string' ? (error as {code:string}).code : '';
  return ['invalid-request','invalid-budget','search-unavailable','operator-actions-disabled','search-expired','invalid-confirmation','invalid-release-selection','settings-changed','destination-changed','operation-not-found','operation-stopped','aborted'].includes(code) ? code : 'operation-failed';
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

function parsePage(query: Record<string, unknown>): { limit: number; offset: number } | null {
  const parse = (value: unknown, fallback: number, max: number): number | null => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d{1,8}$/u.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 && number <= max ? number : null;
  };
  const limit = parse(query.limit, 50, 100);
  const offset = parse(query.offset, 0, 1_000_000);
  return limit === null || limit < 1 || offset === null ? null : { limit, offset };
}
function parseSearch(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.length <= 200 ? value : null;
}
function parseReviewId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,10}$/u.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function safePublicTitle(value: string): string {
  return value.replace(/\b[a-z][a-z\d+.-]{1,15}:\/\/\S+/giu, '[URL]').replace(/magnet:\?\S+/giu, '[URL]')
    .replace(/(?:^|[\s("'=])\/(?:[^/\s]+\/)+[^/\s]+/gu, ' [PATH]').replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/gu, '[PATH]').replace(/\b(?:[\da-f]{64}|[\da-f]{40}|[\da-f]{32})\b/giu, '[HASH]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
}
function safePublicStatus(value: string | null): string {
  return value !== null && /^[a-zA-Z][a-zA-Z0-9-]{0,39}$/u.test(value) ? value : 'unknown';
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const stack = buildStack({ config });
  startDaemon(stack).catch((error: unknown) => { console.error(error instanceof Error ? error.name : 'StartupError'); process.exitCode = 1; });
}
