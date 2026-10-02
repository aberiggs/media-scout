import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino, { type Logger } from 'pino';
import type { CycleSummary } from '../src/core/runner';
import { State } from '../src/core/state';
import type { Stack } from '../src/compose';
import { buildApp, createShutdown } from '../src/daemon';

// The unit under test is the HTTP surface: it touches only config + runner, and runner
// behavior is pinned by tests/runner.test.ts — so a scripted fakeRunner is the right seam here.
function makeStack(runner: { cycle: () => Promise<CycleSummary> }, logger: Logger = pino({ level: 'silent' })): Stack {
  const config = {
    DRY_RUN: true,
    LLM_MODEL: 'test-model',
    CYCLE_INTERVAL_MIN: 5,
    LOG_LEVEL: 'silent',
    HTTP_PORT: 7877,
  };
  // Stack's other members (watcher, clients, llm, …) are never touched by the daemon surface.
  return { config, state: State.open(':memory:'), runner, logger } as unknown as Stack;
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
  it('GET /health returns 200 with status/dryRun/model and never touches the runner', async () => {
    const fake = scriptRunner(() => Promise.resolve(summary));
    const app: FastifyInstance = await buildApp(makeStack(fake));

    const reply = await app.inject({ method: 'GET', url: '/health' });

    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ status: 'ok', dryRun: true, model: 'test-model' });
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

  it('a cycle that throws returns a sanitized 500, logs the original, and the guard resets', async () => {
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
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: 'cycle failed; see server logs' });
    expect(failed.body).not.toContain('sonarr.test');
    expect(failed.body).not.toContain('SECRET');
    // The full original message reaches the server log.
    expect(JSON.stringify(errors)).toContain('http://sonarr.test/api/v3/series?key=SECRET');

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
