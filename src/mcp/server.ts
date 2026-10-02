import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import pino from 'pino';
import { buildStack, type Stack } from '../compose';
import { loadConfig } from '../config';
import type { Release } from '../types/prowlarr';

/**
 * Registers the six media-agent tools on a fresh McpServer (stdio transport attached by runMcpServer/tests).
 * Handler throws are converted by the SDK into isError tool results — one failing call never crashes the server.
 */
export function createMcpServer(stack: Stack): McpServer {
  const server = new McpServer({ name: 'media-agent', version: '0.1.0' });
  const { config, state, runner, prowlarr } = stack;

  // I4: the SDK dispatches tool calls concurrently, but ma_cycle and ma_pick share the runner's
  // decision/hash write path — a promise-chain mutex makes it impossible to run both at once.
  let runnerInFlight: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = runnerInFlight.then(fn);
    runnerInFlight = run.catch(() => undefined);
    return run;
  };

  const jsonResult = (payload: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  });

  server.registerTool('ma_status', { description: 'Config snapshot, open manual-review count, and safe queue-work status.' }, async () =>
    jsonResult({
      dryRun: config.DRY_RUN,
      model: config.LLM_MODEL,
      cycleIntervalMin: config.CYCLE_INTERVAL_MIN,
      openManualReviews: state.listManualReview(false).length,
      workQueue: state.getWorkQueueStatus(),
    }),
  );

  server.registerTool('ma_cycle', { description: 'Run one full watch/search/decide cycle now.' }, async () =>
    exclusive(async () => jsonResult(await runner.cycle())),
  );

  server.registerTool(
    'ma_review_list',
    { description: 'Manual-review queue rows (ambiguous/unparseable picks awaiting a human).', inputSchema: z.object({ includeResolved: z.boolean().default(false) }) },
    async ({ includeResolved }) => jsonResult({ rows: state.listManualReview(includeResolved) }),
  );

  server.registerTool(
    'ma_review_action',
    {
      description: 'Resolve a review or execute a separately prepared, host-approved operator recovery action. Mutating actions require fresh evidence and exact challenge text.',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: z.discriminatedUnion('action', [
        z.object({ id: z.number().int(), action: z.literal('resolve') }).strict(),
        z.object({ id: z.number().int().positive(), action: z.literal('prepare'), operation: z.enum(['associate_queue', 'release_intent_hold']) }).strict(),
        z.object({ id: z.number().int().positive(), action: z.literal('associate_queue'), token: z.string().min(32), proposedAssociation: z.object({ mediaIndex: z.number().int().nonnegative(), targetIndices: z.array(z.number().int().nonnegative()).min(1) }).strict(), challengeResponse: z.string().min(1), note: z.string().min(3).max(500) }).strict(),
        z.object({ id: z.number().int().positive(), action: z.literal('release_intent_hold'), token: z.string().min(32), challengeResponse: z.string().min(1), note: z.string().min(3).max(500) }).strict(),
      ]),
    },
    async (input) => {
      if (input.action === 'resolve') {
        if (!state.resolveManualReview(input.id)) throw new Error(`review row not found or already resolved: id ${input.id}`);
        return jsonResult({ resolved: true });
      }
      if (!config.ALLOW_OPERATOR_ACTIONS) throw new Error('Operator actions are disabled; set ALLOW_OPERATOR_ACTIONS=true to opt in');
      if (input.action === 'prepare') return jsonResult(await stack.operatorActions.prepareReviewAction({ reviewId: input.id, operation: input.operation }));
      if (input.action === 'associate_queue') return jsonResult(await stack.operatorActions.associateQueue({ reviewId: input.id, token: input.token, proposedAssociation: input.proposedAssociation, challengeResponse: input.challengeResponse, note: input.note }));
      return jsonResult(await stack.operatorActions.releaseIntentHold({ reviewId: input.id, token: input.token, challengeResponse: input.challengeResponse, note: input.note }));
    },
  );

  /** Prowlarr-proxied URLs carry apikeys — the mapped view drops every URL field by construction. */
  const toPublicRelease = (r: Release) => ({
    title: r.title,
    indexer: r.indexer,
    size: r.size,
    seeders: r.seeders,
    leechers: r.leechers,
    age: r.age,
    protocol: r.protocol,
    infoHash: r.infoHash,
  });

  server.registerTool(
    'ma_search',
    {
      description: 'Prowlarr search; returns URL-free release summaries (magnet/download URLs are never exposed).',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(500).default(100) }),
    },
    async ({ query, limit }) => {
      const releases = await prowlarr.search({ query, categories: [], limit });
      return jsonResult({ releases: releases.map(toPublicRelease) });
    },
  );

  server.registerTool(
    'ma_pick',
    {
      description: 'Manually grab the chosen candidate (sorted by seeders) for a work unit now.',
      inputSchema: z.object({ workKey: z.string().min(1), releaseIndex: z.number().int().min(0) }),
    },
    ({ workKey, releaseIndex }) => exclusive(async () => jsonResult(await runner.manualPick(workKey, releaseIndex))),
  );

  return server;
}

/** Entry: builds nothing — takes a stack, wires stdio transport, serves until the transport closes. */
export async function runMcpServer(stack: Stack): Promise<void> {
  const server = createMcpServer(stack);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
}

// Sanctioned direct-run entry: no-default-export exception; env is read here (via loadConfig) only.
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  const config = loadConfig();
  // stdout belongs to the JSON-RPC framing — pino must never write there; fd 2, sync so nothing is lost on exit.
  const logger = pino({ level: config.LOG_LEVEL }, pino.destination({ dest: 2, sync: true }));
  const stack = buildStack({ config, logger });
  await runMcpServer(stack);
}
