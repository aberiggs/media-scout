import Fastify, { type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { buildStack, type Stack } from './compose';
import { loadConfig } from './config';
import type { CycleSummary, Runner } from './core/runner';

/** Outcome of one guarded cycle attempt — mapped to HTTP status codes by the route. */
type CycleAttempt =
  | { ok: true; summary: CycleSummary }
  | { ok: false; conflict: true }
  | { ok: false; error: string };

interface CycleGate {
  run(): Promise<CycleAttempt>;
  /** Resolves once any in-flight cycle finishes (best-effort shutdown barrier). */
  settled(): Promise<void>;
}

/** Shared one-at-a-time guard so HTTP POST /cycle and the interval timer never overlap a cycle. */
function createCycleGate(runner: Runner): CycleGate {
  let running = false;
  let inFlight: Promise<unknown> | null = null;
  return {
    async run(): Promise<CycleAttempt> {
      if (running) return { ok: false, conflict: true };
      running = true;
      try {
        const cycle = runner.cycle();
        inFlight = cycle;
        return { ok: true, summary: await cycle };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        running = false;
        inFlight = null;
      }
    },
    async settled(): Promise<void> {
      await inFlight?.catch(() => {});
    },
  };
}

// The gate is shared between the HTTP route and startDaemon's interval timer, so it rides on the app instance.
declare module 'fastify' {
  interface FastifyInstance {
    cycleGate: CycleGate;
  }
}

/** Builds the Fastify app with /health and /cycle wired to the stack (inject-based tests use this). */
export async function buildApp(stack: Stack): Promise<FastifyInstance> {
  // Fastify 5: a pre-built pino instance goes through loggerInstance (logger takes only a config object).
  const app = Fastify({ loggerInstance: stack.logger.child({ component: 'daemon' }) });
  const gate = createCycleGate(stack.runner);
  app.decorate('cycleGate', gate);

  app.get('/health', async () => ({
    status: 'ok',
    dryRun: stack.config.DRY_RUN,
    model: stack.config.LLM_MODEL,
  }));

  app.post('/cycle', async (_request, reply) => {
    const attempt = await gate.run();
    if (attempt.ok) return attempt.summary;
    if ('conflict' in attempt) return reply.code(409).send({ error: 'cycle already running' });
    // ApiError messages can carry upstream URLs (with keys) — the public body stays a constant; the log gets the truth.
    app.log.error({ error: attempt.error }, 'cycle failed');
    return reply.code(500).send({ error: 'cycle failed; see server logs' });
  });

  // pino's concrete Logger is stricter than FastifyBaseLogger (msgPrefix); the instance is behaviorally identical.
  return app as unknown as FastifyInstance;
}

/** Entry: interval loop + signal handling. Thin glue, exercised live at P7. */
export async function startDaemon(stack: Stack): Promise<void> {
  const app = await buildApp(stack);
  const logger: Logger = stack.logger.child({ component: 'daemon' });

  await app.listen({ port: stack.config.HTTP_PORT, host: '0.0.0.0' });

  const timer = setInterval(
    () => {
      void app.cycleGate.run().then((attempt) => {
        if (attempt.ok) logger.info(attempt.summary, 'scheduled cycle finished');
        else if ('conflict' in attempt) logger.info('skipped: cycle already in progress');
        else logger.error({ error: attempt.error }, 'scheduled cycle failed');
      });
    },
    stack.config.CYCLE_INTERVAL_MIN * 60_000,
  );

  // Persistent listeners + one idempotent drain: repeated signals re-enter the same drain, never default termination.
  const drain = createShutdown({
    stopTimer: () => clearInterval(timer),
    awaitSettled: () => app.cycleGate.settled(),
    close: () => app.close(),
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', () => drain('SIGINT'));
  process.on('SIGTERM', () => drain('SIGTERM'));
}

interface ShutdownDeps {
  stopTimer: () => void;
  /** Resolves once any in-flight cycle has finished. */
  awaitSettled: () => Promise<void>;
  close: () => Promise<void>;
  exit: (code: number) => void;
}

/** Idempotent drain: first signal stops the timer, waits out the in-flight cycle, closes, exits; later signals no-op. */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  let draining = false;
  return (_signal: string) => {
    if (draining) return;
    draining = true;
    void (async () => {
      deps.stopTimer();
      await deps.awaitSettled();
      await deps.close();
      deps.exit(0);
    })();
  };
}

// Sanctioned direct-run entry: no-default-export exception; env is read here (via loadConfig) only.
// argv[1] guard: `node -e`/REPL imports have no entry script, so pathToFileURL would throw.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stack = buildStack({ config: loadConfig() });
  await startDaemon(stack);
}
