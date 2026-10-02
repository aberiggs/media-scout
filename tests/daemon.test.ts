import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pino, { type Logger } from 'pino';
import type { CycleSummary } from '../src/core/runner';
import { State } from '../src/core/state';
import type { Stack } from '../src/compose';
import { buildApp, createMonitorScheduler, createShutdown } from '../src/daemon';
import { defaultSettings } from '../src/settings';

// The unit under test is the HTTP surface: it touches only config + runner, and runner
// behavior is pinned by tests/runner.test.ts — so a scripted fakeRunner is the right seam here.
function makeStack(runner: { cycle: () => Promise<CycleSummary> }, logger: Logger = pino({ level: 'silent' }), configure = true): Stack {
  const config = {
    DRY_RUN: true,
    LLM_MODEL: 'test-model',
    CYCLE_INTERVAL_MIN: 5,
    LOG_LEVEL: 'silent',
    HTTP_PORT: 7877,
    HTTP_HOST: '127.0.0.1',
    DB_PATH: ':memory:',
    settings: defaultSettings,
  };
  // Stack's other members (watcher, clients, llm, …) are never touched by the daemon surface.
  const state = State.open(':memory:');
  if (configure) state.saveSettings({ ...defaultSettings, integrations: {
    prowlarr: { url: 'http://p.test', apiKey: 'p', tvClient: 'tv', movieClient: 'movie' },
    sonarr: { url: 'http://s.test', apiKey: 's' }, radarr: { url: 'http://r.test', apiKey: 'r' },
  }, ai: { ...defaultSettings.ai, apiKey: 'llm' } });
  const stack = { config, state, runner, logger } as unknown as Stack;
  stack.createSnapshot = () => stack;
  return stack;
}

const summary: CycleSummary = {
  units: 3,
  searched: 2,
  grabbed: 1,
  dryRunGrabs: 0,
  manualFlagged: 1,
  skipped: 1,
};

// light-my-request dispatches concurrent same-route injects in reverse creation order;
// yielding a tick pins the first request's dispatch before the second is created.
const yieldTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// tsconfig lib is ES2023, so Promise.withResolvers (ES2024) does not typecheck — executor form required.
function deferred<T = CycleSummary>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Fastify calls several pino levels per request; errors are captured for assertions.
function fakeLogger(): { logger: Logger; errors: unknown[] } {
  const errors: unknown[] = [];
  const base = {
    level: 'silent',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (obj: unknown) => {
      errors.push(obj);
    },
    fatal: () => {},
    child: () => base,
  };
  return { logger: base as unknown as Logger, errors };
}

interface ScriptedRunner {
  cycle: () => Promise<CycleSummary>;
  calls: number;
}

function scriptRunner(script: () => Promise<CycleSummary>): ScriptedRunner {
  const fake = { calls: 0, cycle: async () => { fake.calls += 1; return script(); } };
  return fake;
}

describe('daemon HTTP surface', () => {
  it('serves built assets, falls back to the SPA for deep GETs, and keeps API/non-GET misses out of index.html', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'media-scout-web-fixture-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>fixture-spa</title>');
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.info("fixture asset")');
    const app = await buildApp(makeStack(scriptRunner(() => Promise.resolve(summary))), { webRoot });
    try {
      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain('fixture asset');

      const deepRoute = await app.inject({ method: 'GET', url: '/settings/integrations' });
      expect(deepRoute.statusCode).toBe(200);
      expect(deepRoute.body).toContain('fixture-spa');

      for (const url of ['/api?x=1', '/api/no-such-endpoint?x=1', '/cycle?x=1', '/cycle/unknown?x=1', '/health/nonexistent?x=1']) {
        const reservedMiss = await app.inject({ method: 'GET', url });
        expect(reservedMiss.statusCode).toBe(404);
        expect(reservedMiss.json()).toEqual({ error: 'not found' });
        expect(reservedMiss.body).not.toContain('fixture-spa');
      }

      const postMiss = await app.inject({ method: 'POST', url: '/settings/integrations' });
      expect(postMiss.statusCode).toBe(404);
      expect(postMiss.body).not.toContain('fixture-spa');
      const deleteMiss = await app.inject({ method: 'DELETE', url: '/settings/integrations' });
      expect(deleteMiss.statusCode).toBe(404);
      expect(deleteMiss.body).not.toContain('fixture-spa');
    } finally {
      await app.close();
      rmSync(webRoot, { recursive: true, force: true });
    }
  });

  it('GET /health returns 200 with status/dryRun/model and never touches the runner', async () => {
    const fake = scriptRunner(() => Promise.resolve(summary));
    const app: FastifyInstance = await buildApp(makeStack(fake));

    const reply = await app.inject({ method: 'GET', url: '/health' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ status: 'ok', dryRun: true, model: defaultSettings.ai.model });
    expect(fake.calls).toBe(0);
  });

  it('POST /cycle returns the CycleSummary from runner.cycle()', async () => {
    const fake = scriptRunner(() => Promise.resolve(summary));
    const app = await buildApp(makeStack(fake));

    const reply = await app.inject({ method: 'POST', url: '/cycle' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual(summary);
    expect(fake.calls).toBe(1);
  });

  it('POST /cycle while a cycle is pending returns 409 and starts no second cycle; guard resets afterwards', async () => {
    const gate = deferred();
    const fake = scriptRunner(() => gate.promise);
    const app = await buildApp(makeStack(fake));

    const first = app.inject({ method: 'POST', url: '/cycle' });
    await yieldTick();
    const conflict = await app.inject({ method: 'POST', url: '/cycle' });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'cycle already running' });

    gate.resolve(summary);
    const firstReply = await first;
    expect(firstReply.statusCode).toBe(200);
    expect(firstReply.json()).toEqual(summary);

    // Guard resets after completion: the next POST runs a fresh cycle.
    const third = await app.inject({ method: 'POST', url: '/cycle' });
    expect(third.statusCode).toBe(200);
    expect(third.json()).toEqual(summary);
    expect(fake.calls).toBe(2);
  });

  it('a cycle that throws returns a sanitized 503, logs only safe type, and the guard resets', async () => {
    const { logger, errors } = fakeLogger();
    const gate = deferred();
    let call = 0;
    // First call rejects; later calls resolve — proves the guard resets after a failure.
    const fake = scriptRunner(() => {
      call += 1;
      return call === 1 ? gate.promise : Promise.resolve(summary);
    });
    const app = await buildApp(makeStack(fake, logger));

    const failing = app.inject({ method: 'POST', url: '/cycle' });
    gate.reject(new Error('HTTP 500 http://sonarr.test/api/v3/series?key=SECRET'));
    const failed = await failing;

    // Public body is a constant — upstream URLs/keys never leak to an unauthenticated listener.
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: 'cycle unavailable; check settings and server logs' });
    expect(failed.body).not.toContain('sonarr.test');
    expect(failed.body).not.toContain('SECRET');
    // Exception messages are never logged because upstream messages can contain credentials.
    expect(JSON.stringify(errors)).not.toContain('SECRET');

    // No permanent lock after a failure.
    const next = await app.inject({ method: 'POST', url: '/cycle' });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toEqual(summary);
  });

  it('responses leak no magnetUrl/downloadUrl', async () => {
    const app = await buildApp(makeStack(scriptRunner(() => Promise.resolve(summary))));
    const health = await app.inject({ method: 'GET', url: '/health' });
    const cycle = await app.inject({ method: 'POST', url: '/cycle' });
    for (const reply of [health, cycle]) {
      expect(reply.body).not.toContain('magnetUrl');
      expect(reply.body).not.toContain('downloadUrl');
    }
    const missingApi = await app.inject({ method: 'GET', url: '/api/not-a-route' });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.body).not.toContain('<!doctype html>');
  });

  it('GET settings returns defaults and PUT is atomic, durable, and rejects cross-origin mutation', async () => {
    const stack = makeStack(scriptRunner(() => Promise.resolve(summary)));
    const app = await buildApp(stack);
    const empty = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().settings.monitoring.enabled).toBe(false);
    expect(empty.json().settings.safety.dryRun).toBe(true);
    expect(empty.json().status.ready).toBe(true); // helper initializes valid integration fixtures
    const before = stack.state.getSettings();
    const invalid = await app.inject({ method: 'PUT', url: '/api/settings', payload: { ...before, monitoring: { ...before.monitoring, failureBackoffMaxMinutes: 1 } } });
    expect(invalid.statusCode).toBe(400);
    expect(stack.state.getSettings()).toEqual(before);
    const crossOrigin = await app.inject({ method: 'PUT', url: '/api/settings', headers: { origin: 'http://evil.test' }, payload: before });
    expect(crossOrigin.statusCode).toBe(403);
    await app.close();
  });

  it('empty setup is visible and cycle work remains blocked while health/settings stay available', async () => {
    const fake = scriptRunner(() => Promise.resolve(summary));
    const app = await buildApp(makeStack(fake, pino({ level: 'silent' }), false));
    const settings = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().status.ready).toBe(false);
    expect(settings.json().status.missing).toContain('ai.apiKey');
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/cycle' })).statusCode).toBe(503);
    expect(fake.calls).toBe(0);
    await app.close();
  });

  it('each new cycle takes a fresh settings snapshot', async () => {
    const gate = deferred();
    let calls = 0;
    const fake = scriptRunner(() => { calls += 1; return calls === 1 ? gate.promise : Promise.resolve(summary); });
    const stack = makeStack(fake);
    const prefs: string[] = [];
    stack.createSnapshot = (settings) => { prefs.push(settings.ai.preferences); return stack; };
    const app = await buildApp(stack);
    const first = app.inject({ method: 'POST', url: '/cycle' });
    await yieldTick();
    const changed = { ...stack.state.getSettings(), ai: { ...stack.state.getSettings().ai, preferences: 'fresh settings' } };
    await app.inject({ method: 'PUT', url: '/api/settings', payload: changed });
    expect(prefs).toEqual(['']); // the in-flight operation retains its coherent old snapshot
    gate.resolve(summary);
    await first;
    await app.inject({ method: 'POST', url: '/cycle' });
    expect(prefs).toEqual(['', 'fresh settings']);
    await app.close();
  });
});

describe('shutdown drain', () => {
  it('drains in order (timer → settled → close → exit) and repeated signals re-trigger the same drain once', async () => {
    const order: string[] = [];
    const settled = deferred<void>();
    const exitCodes: number[] = [];
    const onSignal = createShutdown({
      stopTimer: () => {
        order.push('stopTimer');
      },
      awaitSettled: () => {
        order.push('await-settled');
        return settled.promise.then(() => {
          order.push('settled-done');
        });
      },
      close: async () => {
        order.push('close');
      },
      exit: (code) => {
        exitCodes.push(code);
        order.push(`exit:${code}`);
      },
    });

    onSignal('SIGINT');
    // Second signal while draining: re-triggers the SAME drain — no default termination, no second exit.
    onSignal('SIGINT');
    settled.resolve(undefined);
    await yieldTick();

    expect(order).toEqual(['stopTimer', 'await-settled', 'settled-done', 'close', 'exit:0']);
    expect(exitCodes).toEqual([0]);
  });
});

describe('monitor scheduler settings', () => {
  it('reschedules immediately on interval changes, disables cleanly, and never launches overlapping tasks', async () => {
    vi.useFakeTimers();
    try {
      let settings = { ...defaultSettings, monitoring: { ...defaultSettings.monitoring, enabled: true, intervalMinutes: 5 } };
      const gate = deferred<void>();
      let calls = 0;
      const scheduler = createMonitorScheduler(() => settings, () => { calls += 1; return gate.promise; });
      scheduler.refresh();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(calls).toBe(0);
      settings = { ...settings, monitoring: { ...settings.monitoring, intervalMinutes: 1 } };
      scheduler.refresh();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(1);
      // A second timeout must not be installed until the current task settles.
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(calls).toBe(1);
      gate.resolve(undefined);
      await Promise.resolve();
      await Promise.resolve();
      settings = { ...settings, monitoring: { ...settings.monitoring, enabled: false } };
      scheduler.refresh();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(calls).toBe(1);
      scheduler.stop();
    } finally { vi.useRealTimers(); }
  });
});
