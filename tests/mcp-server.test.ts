import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pino, { type Logger } from 'pino';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildStack, type Stack } from '../src/compose';
import { configWithSettings, loadConfig } from '../src/config';
import { defaultSettings } from '../src/settings';
import { State } from '../src/core/state';
import { createMcpServer } from '../src/mcp/server';
import { ApiError } from '../src/http';
import type { LLMClient } from '../src/clients/llm';
import type { ZodType } from 'zod';
import { plannedQueriesSchema, type PlannedQuery } from '../src/core/planner';
import type { PickVerdict } from '../src/core/picker';
import type { GroupPlanEnvelope, GroupSelectionEnvelope } from '../src/types/group-llm';
import { sonarrQueuePageSchema } from '../src/types/sonarr';
import { radarrQueuePageSchema } from '../src/types/radarr';

const PROWLARR = 'http://prowlarr.test';
const SONARR = 'http://sonarr.test';
const RADARR = 'http://radarr.test';
const NOW = new Date('2026-09-29T00:00:00Z');
const emptyQueueEnvelope = { page: 1, pageSize: 100, totalRecords: 0, records: [], sortKey: 'timeleft', sortDirection: 'ascending' };
const emptySonarrQueuePage = sonarrQueuePageSchema.parse(emptyQueueEnvelope);
const emptyRadarrQueuePage = radarrQueuePageSchema.parse(emptyQueueEnvelope);

const seriesFixture = JSON.parse(
  readFileSync(new URL('./fixtures/sonarr-series.json', import.meta.url), 'utf8'),
);
const releaseFixture = JSON.parse(
  readFileSync(new URL('./fixtures/prowlarr-release.json', import.meta.url), 'utf8'),
);
const downloadClientsFixture = JSON.parse(
  readFileSync(new URL('./fixtures/prowlarr-downloadclients.json', import.meta.url), 'utf8'),
);
const indexersFixture = JSON.parse(
  readFileSync(new URL('./fixtures/prowlarr-indexers.json', import.meta.url), 'utf8'),
);
const episodesJson = JSON.parse(
  readFileSync(new URL('./fixtures/sonarr-episodes.json', import.meta.url), 'utf8'),
);

/** Chat-completions envelope wrapping a fenced-JSON message, as the OpenRouter-compatible stub returns. */
const llmReply = (content: string) => ({
  id: 'resp1',
  created: 1700000000,
  object: 'chat.completion',
  model: 'stub-model',
  system_fingerprint: 'fp1',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

const release = (overrides: Record<string, unknown> = {}) => ({ ...releaseFixture, ...overrides });

const tvSeries = (id: number, title: string, tvdbId: number) => ({
  ...seriesFixture,
  id,
  tvdbId,
  title,
  seriesType: 'anime',
  alternateTitles: [],
});

const episode = (seriesId: number, overrides: Record<string, unknown> = {}) => ({
  id: 0,
  seriesId,
  seasonNumber: 1,
  episodeNumber: 1,
  absoluteEpisodeNumber: null,
  title: 'Episode',
  airDate: '2023-10-20',
  monitored: true,
  hasFile: false,
  ...overrides,
});

const episodesFor = (s: { id: number; seriesType: string }) => [
  episode(s.id, { id: s.id * 100 + 1, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'Like a Fairy Tale' }),
  episode(s.id, { id: s.id * 100 + 3, episodeNumber: 9, absoluteEpisodeNumber: 9, airDate: null }),
];

/** Scripted LLM: planner/picker outputs keyed by unit key (same seam as runner tests). */
class FakeLLM implements LLMClient {
  readonly planner = new Map<string, PlannedQuery[]>();
  readonly picks = new Map<string, PickVerdict>();
  readonly groupPlanner = new Map<string, GroupPlanEnvelope>();
  readonly groupPicks = new Map<string, GroupSelectionEnvelope>();
  readonly labels: string[] = [];

  async json<T>(args: { system: string; user: string; schema: ZodType<T>; label: string }): Promise<T> {
    this.labels.push(args.label);
    if (args.label.startsWith('planner:group:')) {
      const key = args.label.slice('planner:group:'.length);
      const plan = this.groupPlanner.get(key) ?? this.groupPlanner.get('*');
      if (!plan) throw new Error(`no group planner script for ${key}`);
      return args.schema.parse(plan);
    }
    if (args.label.startsWith('picker:group:')) {
      const key = args.label.slice('picker:group:'.length);
      const selection = this.groupPicks.get(key) ?? this.groupPicks.get('*');
      if (!selection) throw new Error(`no group picker script for ${key}`);
      return args.schema.parse(selection);
    }
    if (args.label.startsWith('planner:')) {
      const key = args.label.slice('planner:'.length);
      const queries = this.planner.get(key) ?? this.planner.get('*');
      if (!queries) throw new Error(`no planner script for ${key}`);
      return args.schema.parse(plannedQueriesSchema.parse({ queries }));
    }
    if (args.label.startsWith('picker:')) {
      const key = args.label.slice('picker:'.length);
      const verdict = this.picks.get(key);
      if (!verdict) throw new Error(`no picker script for ${key}`);
      return args.schema.parse(verdict);
    }
    throw new Error(`unscripted LLM label: ${args.label}`);
  }
}

function testConfigFromEnv(env: Record<string, string>) {
  const defaults = defaultSettings;
  const n = (key: string, fallback: number) => Number(env[key] ?? fallback);
  const config = configWithSettings(loadConfig({ DB_PATH: env.DB_PATH }), {
    ...defaults,
    integrations: {
      prowlarr: { url: env.PROWLARR_URL ?? PROWLARR, apiKey: env.PROWLARR_API_KEY ?? 'prowlarr-key', tvClient: env.PROWLARR_CLIENT_TV ?? 'qBit-TV', movieClient: env.PROWLARR_CLIENT_MOVIE ?? 'qBit-Movies' },
      sonarr: { url: env.SONARR_URL ?? SONARR, apiKey: env.SONARR_API_KEY ?? 'sonarr-key' },
      radarr: { url: env.RADARR_URL ?? RADARR, apiKey: env.RADARR_API_KEY ?? 'radarr-key' },
    },
    ai: { apiKey: env.LLM_API_KEY ?? 'llm-key', model: env.LLM_MODEL ?? defaults.ai.model, baseUrl: env.LLM_BASE_URL ?? defaults.ai.baseUrl, preferences: env.MEDIA_PREFERENCES ?? '' },
    monitoring: { ...defaults.monitoring, intervalMinutes: n('CYCLE_INTERVAL_MIN', 5), minRetryHours: n('MIN_RETRY_HOURS', 6), failureBackoffMinMinutes: n('FAILURE_BACKOFF_MIN', 5), failureBackoffMaxMinutes: n('FAILURE_BACKOFF_MAX_MIN', 60), queueGraceMinutes: n('QUEUE_GRACE_MIN', 30) },
    safety: { dryRun: env.DRY_RUN !== 'false', allowOperatorActions: env.ALLOW_OPERATOR_ACTIONS === 'true' },
  });
  return config;
}

const testConfig = testConfigFromEnv({
  PROWLARR_URL: PROWLARR,
  PROWLARR_API_KEY: 'prowlarr-key',
  SONARR_URL: SONARR,
  SONARR_API_KEY: 'sonarr-key',
  RADARR_URL: RADARR,
  RADARR_API_KEY: 'radarr-key',
  PROWLARR_CLIENT_TV: 'qBit-TV',
  PROWLARR_CLIENT_MOVIE: 'qBit-Movies',
  LLM_API_KEY: 'llm-key',
  DRY_RUN: 'false',
  DB_PATH: ':memory:',
});

const grabBody = {
  indexerId: 5,
  guid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
  downloadClientId: 1,
};

/** Wires the work-discovery + Prowlarr plumbing mocks shared by cycle/pick scenarios. */
function mockDiscovery(opts: { series?: unknown[]; times?: number; persistLibraryReads?: boolean } = {}) {
  const n = opts.times ?? 1;
  const queueReads = { sonarr: 0, radarr: 0 };
  const seriesRoute = opts.persistLibraryReads
    ? nock(SONARR).persist().get('/api/v3/series')
    : nock(SONARR).get('/api/v3/series').times(n);
  seriesRoute.reply(200, opts.series ?? []);
  for (const s of opts.series ?? []) {
    const episodeRoute = opts.persistLibraryReads
      ? nock(SONARR).persist().get('/api/v3/episode').query({ seriesId: (s as { id: number }).id })
      : nock(SONARR).get('/api/v3/episode').query({ seriesId: (s as { id: number }).id }).times(n);
    episodeRoute.reply(200, episodesFor(s as { id: number; seriesType: string }));
  }
  const movieRoute = opts.persistLibraryReads
    ? nock(RADARR).persist().get('/api/v3/movie')
    : nock(RADARR).get('/api/v3/movie').times(n);
  movieRoute.reply(200, []);
  nock(PROWLARR).get('/api/v1/downloadclient').times(n).reply(200, downloadClientsFixture);
  nock(PROWLARR).get('/api/v1/indexer').times(n).reply(200, indexersFixture);
  nock(PROWLARR).get('/api/v1/indexerstatus').times(n).reply(200, []);
  nock(SONARR)
    .persist()
    .get('/api/v3/queue')
    .query({ includeUnknownSeriesItems: 'true', includeSeries: 'false', includeEpisode: 'false', page: '1', pageSize: '100' })
    .reply(200, () => { queueReads.sonarr += 1; return emptySonarrQueuePage; });
  nock(RADARR)
    .persist()
    .get('/api/v3/queue')
    .query({ includeUnknownMovieItems: 'true', includeMovie: 'false', page: '1', pageSize: '100' })
    .reply(200, () => { queueReads.radarr += 1; return emptyRadarrQueuePage; });
  return queueReads;
}

let stack: Stack;
let client: Client;
let serverTransport: InMemoryTransport;

beforeEach(() => {
  if (!nock.isActive()) nock.activate();
  nock.disableNetConnect();
});

afterEach(async () => {
  nock.cleanAll();
  if (client) await client.close();
  if (serverTransport) await serverTransport.close();
});

/** Connects a fresh in-memory client to a fresh server over a live compose stack. */
async function connect(llm: FakeLLM): Promise<Client> {
  stack = buildStack({ config: testConfig, llm, now: () => NOW, logger: pino({ level: 'silent' }) });
  stack.state.saveSettings(testConfig.settings);
  const server = createMcpServer(stack);
  const [clientTransport, serverT] = InMemoryTransport.createLinkedPair();
  serverTransport = serverT;
  await Promise.all([server.connect(serverTransport), clientTransport.start()]);
  client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** Extracts the text of a tool result's first content item, failing loudly when absent. */
const textContentSchema = z.object({ text: z.string() });
const toolResultContentSchema = z.object({ content: z.array(z.unknown()) });
function firstText(result: unknown): string {
  const { content } = toolResultContentSchema.parse(result);
  const first = content[0];
  if (first === undefined) throw new Error('tool returned no content');
  return textContentSchema.parse(first).text;
}

/** Calls a tool and returns the parsed JSON payload of the text content. */
async function callJson(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBeFalsy();
  return JSON.parse(firstText(result)) as Record<string, unknown>;
}

/** Calls a tool expected to fail and returns the error text. */
async function callErrorText(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return firstText(result);
}

describe('mcp server tools', () => {
  it('exposes general search and a mutating general grab tool with a ten-release limit', async () => {
    await connect(new FakeLLM());
    const listed = await client.listTools();
    const searchTool = listed.tools.find(({ name }) => name === 'ma_general_search');
    const grabTool = listed.tools.find(({ name }) => name === 'ma_general_grab');
    expect(searchTool).toBeDefined();
    expect(grabTool?.description).toContain('separate explicit approval');
    expect(grabTool?.inputSchema.properties?.releaseIds).toMatchObject({ maxItems: 10 });
  });

  it('ma_status reports config + open review count', async () => {
    await connect(new FakeLLM());
    stack.state.flagManualReview('sonarr:1:s1', 'unparseable-title', 'Some.Trash.mkv', NOW);
    stack.state.flagManualReview('radarr:9', 'unparseable-title', 'Other.Trash.mkv', NOW);
    stack.state.resolveManualReview(1, NOW);

    const status = await callJson('ma_status');

    expect(status).toEqual({
      dryRun: false,
      model: testConfig.LLM_MODEL,
      cycleIntervalMin: testConfig.CYCLE_INTERVAL_MIN,
      ready: true,
      missing: [],
      openManualReviews: 1,
      workQueue: {
        items: [],
        counts: { ready: 0, 'waiting-release': 0, searching: 0, cooldown: 0, backoff: 0, manual: 0, fulfilled: 0, inactive: 0 },
        openIntentCount: 0,
      },
    });
  });

  it('ma_status exposes a persisted safe queue projection, not unit or hold details', async () => {
    await connect(new FakeLLM());
    const workKey = 'sonarr:42:s1';
    const owner = stack.state.claimUnit(workKey, NOW);
    expect(owner).not.toBeNull();
    stack.state.applyWorkReconciliation({
      key: workKey,
      token: owner!,
      intentUpdates: [],
      work: {
        workKey,
        contentIdentity: 'private-content-identity',
        missingFingerprint: 'private-missing-fingerprint',
        unit: {
          key: workKey,
          kind: 'tv',
          arr: 'sonarr',
          serviceId: 42,
          externalId: 900,
          title: 'Private WorkUnit title',
          altTitles: [],
          seriesType: 'standard',
          season: {
            seasonNumber: 1,
            missing: [{ episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Private episode title' }],
          },
        },
        status: 'waiting-release',
        lastSearchAt: null,
        nextSearchAt: '2026-09-29T01:00:00.000Z',
        failCount: 2,
        lastOutcome: 'release-not-found',
        lastObservedAt: NOW.toISOString(),
        lastQueueObservedAt: null,
        queueObservationKnown: false,
        blockedReason: 'private raw hold details must stay internal',
      },
    });
    const intent = stack.state.beginGrab({
      key: workKey,
      token: owner!,
      fingerprint: 'private-missing-fingerprint',
      release: {
        arr: 'sonarr',
        indexerId: 5,
        guid: 'private-release-guid',
        infoHash: 'private-info-hash',
        releaseTitle: 'Private intent release title',
      },
      coverage: [{ workKey, episodeIds: [101], basis: 'explicit-episodes' }],
      now: NOW.toISOString(),
      deadline: '2026-09-29T00:30:00.000Z',
    });
    expect(intent.ok).toBe(true);
    stack.state.releaseClaim(workKey, owner!);

    const status = await callJson('ma_status');

    expect(status.workQueue).toEqual({
      items: [{
        workKey,
        status: 'waiting-release',
        nextSearchAt: '2026-09-29T01:00:00.000Z',
        lastObservedAt: NOW.toISOString(),
        lastQueueObservedAt: null,
        queueObservationKnown: false,
        missingCount: 1,
        coveredEpisodeIds: [101],
        safeHoldReason: 'blocked',
      }],
      counts: { ready: 0, 'waiting-release': 1, searching: 0, cooldown: 0, backoff: 0, manual: 0, fulfilled: 0, inactive: 0 },
      openIntentCount: 1,
    });
    const json = JSON.stringify(status);
    expect(json).not.toContain('private-content-identity');
    expect(json).not.toContain('private-missing-fingerprint');
    expect(json).not.toContain('Private WorkUnit title');
    expect(json).not.toContain('Private episode title');
    expect(json).not.toContain('private raw hold details');
    expect(json).not.toContain('private-release-guid');
    expect(json).not.toContain('private-info-hash');
    expect(json).not.toContain('Private intent release title');
    expect(json).not.toContain('ownerToken');
  });

  it('buildStack wires its real queue clients and validated queue controls into Runner', () => {
    const config = testConfigFromEnv({
      PROWLARR_URL: PROWLARR, PROWLARR_API_KEY: 'prowlarr-key',
      SONARR_URL: SONARR, SONARR_API_KEY: 'sonarr-key',
      RADARR_URL: RADARR, RADARR_API_KEY: 'radarr-key',
      PROWLARR_CLIENT_TV: 'qBit-TV', PROWLARR_CLIENT_MOVIE: 'qBit-Movies',
      LLM_API_KEY: 'llm-key', DB_PATH: ':memory:', DRY_RUN: 'true',
      FAILURE_BACKOFF_MIN: '7', FAILURE_BACKOFF_MAX_MIN: '42', QUEUE_GRACE_MIN: '18',
    });
    const composed = buildStack({ config, llm: new FakeLLM(), logger: pino({ level: 'silent' }) });
    try {
      const deps = (composed.runner as unknown as { deps: {
        sonarr: unknown;
        radarr: unknown;
        config: { dryRun: boolean; minRetryHours: number; failureBackoffMin: number; failureBackoffMaxMin: number; queueGraceMin: number };
      } }).deps;
      expect(deps.sonarr).toBe(composed.sonarr);
      expect(deps.radarr).toBe(composed.radarr);
      expect(deps.config).toEqual({
        dryRun: true,
        minRetryHours: config.MIN_RETRY_HOURS,
        failureBackoffMin: 7,
        failureBackoffMaxMin: 42,
        queueGraceMin: 18,
      });
    } finally {
      (composed.state as unknown as { db: { close(): void } }).db.close();
    }
  });

  it('composition logs only safe watcher error type/status and context', async () => {
    const events: Record<string, unknown>[] = [];
    const fakeLogger = {
      child() { return this; },
      warn(fields: Record<string, unknown>) { events.push(fields); },
    } as unknown as Logger;
    const config = testConfigFromEnv({
      PROWLARR_URL: PROWLARR, PROWLARR_API_KEY: 'prowlarr-key',
      SONARR_URL: SONARR, SONARR_API_KEY: 'sonarr-key',
      RADARR_URL: RADARR, RADARR_API_KEY: 'radarr-key',
      PROWLARR_CLIENT_TV: 'qBit-TV', PROWLARR_CLIENT_MOVIE: 'qBit-Movies', LLM_API_KEY: 'llm-key',
      DB_PATH: ':memory:',
    });
    nock(SONARR).get('/api/v3/series').reply(503, 'sensitive body https://private.test/path?apikey=secret');
    nock(RADARR).get('/api/v3/movie').reply(200, []);
    const composed = buildStack({ config, llm: new FakeLLM(), logger: fakeLogger });
    try {
      await composed.watcher.getWorkUnits();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ errorType: 'ApiError', httpStatus: 503, context: 'sonarr.getSeries' });
      const log = JSON.stringify(events);
      expect(log).not.toContain('sensitive body');
      expect(log).not.toContain('private.test');
      expect(log).not.toContain('secret');
      expect(log).not.toContain('url');
    } finally {
      (composed.state as unknown as { db: { close(): void } }).db.close();
    }
  });

  it('ma_cycle returns the real CycleSummary from a scripted happy grab', async () => {
    const llm = new FakeLLM();
    llm.groupPlanner.set('sonarr:1', { queries: [{ query: 'Frieren', categories: [5070], targetIndices: [0] }] });
    llm.groupPicks.set('sonarr:1', { selection: { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'healthy season fit' } });
    const queueReads = mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)], persistLibraryReads: true });
    nock(PROWLARR).get('/api/v1/search').query(true).reply(200, [release()]);
    const grabScope = nock(PROWLARR).post('/api/v1/search', grabBody).reply(201, {});
    await connect(llm);

    const summary = await callJson('ma_cycle');

    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 1, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 });
    expect(grabScope.isDone()).toBe(true);
    expect(queueReads.sonarr).toBeGreaterThanOrEqual(2); // initial observation plus fresh pre-grab check
    expect(queueReads.radarr).toBeGreaterThanOrEqual(1);
    expect(stack.state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(true);
    expect(stack.state.listGrabIntents()).toHaveLength(1);
    expect(stack.state.listGrabIntents()[0]).toMatchObject({
      status: 'awaiting-queue',
      coverage: [{ workKey: 'sonarr:1:s1', episodeIds: [101], basis: 'explicit-episodes' }],
    });
    expect(llm.labels).toEqual(['planner:group:sonarr:1', 'picker:group:sonarr:1']);
  });

  it('ma_review_list shows a flagged row; ma_review_action resolves it', async () => {
    await connect(new FakeLLM());
    stack.state.flagManualReview('sonarr:1:s1', 'unparseable-title', 'Some.Trash.mkv', NOW);

    const listed = await callJson('ma_review_list');
    const rows = listed.rows as { id: number; workKey: string; reason: string; details: string | null; createdAt: string; resolvedAt: string | null }[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('expected exactly one review row');
    expect(row).toMatchObject({ workKey: 'sonarr:1:s1', reason: 'unparseable-title', details: 'Some.Trash.mkv', resolvedAt: null });
    expect(row.createdAt).toBeTruthy();

    const action = await callJson('ma_review_action', { id: row.id, action: 'resolve' });
    expect(action).toEqual({ resolved: true });
    expect(stack.state.listManualReview()).toHaveLength(0);
    const resolved = await callJson('ma_review_list', { includeResolved: true });
    const resolvedRows = resolved.rows as { resolvedAt: string | null }[];
    const resolvedRow = resolvedRows[0];
    if (!resolvedRow) throw new Error('expected the resolved row under includeResolved');
    expect(resolvedRow.resolvedAt).not.toBeNull();
  });

  it('ma_review_action rejects an unknown action value via the input schema', async () => {
    await connect(new FakeLLM());
    // Input-validation failures come back as isError results (SDK converts invalid params to a tool error).
    const errText = await callErrorText('ma_review_action', { id: 1, action: 'delete' });
    expect(errText).toContain('resolve');
  });

  it('ma_search maps releases without magnetUrl/downloadUrl or any URLs', async () => {
    await connect(new FakeLLM());
    const searchScope = nock(PROWLARR)
      .get('/api/v1/search')
      .query((q) => {
        const raw = q as Record<string, unknown>;
        return raw.query === 'Frieren' && raw.indexerIds === undefined && raw.limit === '100';
      })
      .reply(200, [release(), release({ protocol: 'usenet', infoHash: null })]);

    const result = await callJson('ma_search', { query: 'Frieren' });
    expect(searchScope.isDone()).toBe(true);

    const releases = result.releases as Record<string, unknown>[];
    expect(releases).toEqual([
      {
        title: "[SubsPlease] Frieren - Beyond Journey's End - 07 (1080p) [B7C4E4A8].mkv",
        indexer: 'Nyaa.si',
        size: 3461305139,
        seeders: 421,
        leechers: 12,
        age: 2,
        protocol: 'torrent',
        infoHash: 'FIXTUREHASH0000000000000000000000000',
      },
      {
        title: "[SubsPlease] Frieren - Beyond Journey's End - 07 (1080p) [B7C4E4A8].mkv",
        indexer: 'Nyaa.si',
        size: 3461305139,
        seeders: 421,
        leechers: 12,
        age: 2,
        protocol: 'usenet',
        infoHash: null,
      },
    ]);

    const raw = JSON.stringify(result);
    expect(raw).not.toContain('magnet');
    expect(raw).not.toContain('downloadUrl');
    expect(raw).not.toContain('http');
    expect(raw).not.toContain('apikey');
    expect(stack.state.listSearchActivity()).toMatchObject([{ source: 'manual', query: 'Frieren', resultCount: 2, outcome: 'success' }]);
  });

  it('MCP upstream failures retain HTTP status but never expose credential URLs or response bodies', async () => {
    await connect(new FakeLLM());
    const createSnapshot = stack.createSnapshot;
    stack.createSnapshot = (settings) => {
      const current = createSnapshot(settings);
      return {
        ...current,
        prowlarr: { search: async () => { throw new ApiError(503, 'https://prowlarr.test/api?apikey=credential-SECRET', 'upstream body contains credential-SECRET'); } },
      } as unknown as Stack;
    };

    const message = await callErrorText('ma_search', { query: 'test' });
    expect(message).toContain('HTTP 503');
    expect(message).not.toContain('prowlarr.test');
    expect(message).not.toContain('credential-SECRET');
    expect(message).not.toContain('upstream body');
    expect(stack.state.listSearchActivity()).toMatchObject([{ source: 'manual', query: 'test', resultCount: null, outcome: 'error', errorCode: 'http-503' }]);
  });

  it('ma_pick grabs a chosen release, preserves out-of-range errors, and holds submitted coverage', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.planner.set('sonarr:2:s1', [{ query: 'Frieren', categories: [5070] }]);
    const queueReads = mockDiscovery({
      series: [
        tvSeries(1, "Frieren: Beyond Journey's End", 368013),
        tvSeries(2, "Frieren: Beyond Journey's End", 368013),
      ],
      times: 2,
    });
    let searchCalls = 0;
    const searchScope = nock(PROWLARR)
      .get('/api/v1/search')
      .query(true)
      .twice()
      .reply(200, () => {
        searchCalls += 1;
        return [release({
          guid: searchCalls === 1 ? releaseFixture.guid : 'bad-index-guid',
          infoHash: searchCalls === 1 ? releaseFixture.infoHash : 'BADINDEXHASH',
          title: '[SubsPlease] Frieren - 07 (1080p)',
          seeders: 421,
        })];
      });
    const grabScope = nock(PROWLARR).post('/api/v1/search', grabBody).reply(201, {});
    await connect(llm);

    const pick = await callJson('ma_pick', { workKey: 'sonarr:1:s1', releaseIndex: 0 });
    expect(grabScope.isDone()).toBe(true);
    expect(searchScope.isDone()).toBe(false); // one of two expected searches has completed
    expect(pick).toMatchObject({ outcome: 'grabbed', coveredEpisodeNumbers: [7] });
    expect(pick.releaseTitle).toContain('SubsPlease');
    expect(queueReads.sonarr).toBeGreaterThanOrEqual(2); // initial observation plus fresh pre-grab check
    expect(queueReads.radarr).toBeGreaterThanOrEqual(1);

    // A separate work item proves the index bounds error still surfaces before any grab.
    const errText = await callErrorText('ma_pick', { workKey: 'sonarr:2:s1', releaseIndex: 5 });
    expect(errText).toContain('out of range');
    expect(searchScope.isDone()).toBe(true);
    expect(searchCalls).toBe(2);
    expect(llm.labels).toEqual(['planner:sonarr:1:s1', 'planner:sonarr:2:s1']);

    // The first submitted coverage remains held; repeating that key cannot plan or search it again.
    const heldError = await callErrorText('ma_pick', { workKey: 'sonarr:1:s1', releaseIndex: 0 });
    expect(heldError).toMatch(/held|queue|intent|not currently actionable/i);
    expect(llm.labels).toEqual(['planner:sonarr:1:s1', 'planner:sonarr:2:s1']);
    expect(searchCalls).toBe(2);

    const status = await callJson('ma_status');
    expect(status.openManualReviews).toBe(0);
  });

  it('ma_pick on a held cross-process claim does not plan, search, or grab', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    const queueReads = mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    let searches = 0;
    let grabs = 0;
    nock(PROWLARR).persist().get('/api/v1/search').query(true).reply(200, () => { searches += 1; return []; });
    nock(PROWLARR).persist().post('/api/v1/search').reply(201, () => { grabs += 1; return {}; });
    await connect(llm);
    const heldOwner = stack.state.claimUnit('sonarr:1:s1', NOW); // another process (daemon) holds it
    expect(heldOwner).not.toBeNull();

    const errText = await callErrorText('ma_pick', { workKey: 'sonarr:1:s1', releaseIndex: 0 });
    expect(errText).toMatch(/held|in-flight|claim|queue/i);
    expect(llm.labels).toEqual([]);
    expect(searches).toBe(0);
    expect(grabs).toBe(0);
    expect(queueReads.sonarr).toBeGreaterThanOrEqual(1);
    expect(queueReads.radarr).toBeGreaterThanOrEqual(1);
    expect(stack.state.claimUnit('sonarr:1:s1', NOW)).toBeNull(); // original owner still holds the unit
  });

  it('ma_review_action with an unknown id surfaces a tool error mentioning not found', async () => {
    await connect(new FakeLLM());
    const errText = await callErrorText('ma_review_action', { id: 999, action: 'resolve' });
    expect(errText).toContain('not found');
  });

  it('ma_search rejects a limit above the 500 cap via the input schema', async () => {
    await connect(new FakeLLM());
    const errText = await callErrorText('ma_search', { query: 'Frieren', limit: 501 });
    expect(errText).toContain('500');
  });

  it('concurrent ma_pick calls are serialized, not overlapped', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    // The serialized second call re-observes the first call's persisted awaiting-queue intent.
    const queueReads = mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)], times: 2 });
    const releases = [
      release({ title: '[SubsPlease] Frieren - 07 (1080p)', seeders: 421 }),
      release({ guid: 'second-guid', infoHash: 'SECONDHASH', title: '[Group] Frieren - 07 (720p)', seeders: 12 }),
    ];
    let searchCalls = 0;
    let grabCalls = 0;
    // First search parks on a resolver; the signal proves the request actually arrived (no timer guess).
    // Executor form required: Promise.withResolvers is unavailable under the project's ES2023 lib.
    let unblockFirstSearch!: (value: unknown[]) => void;
    const firstSearchStarted = new Promise<void>((resolve) => {
      nock(PROWLARR).get('/api/v1/search').query(true).reply(() => {
        searchCalls += 1;
        resolve();
        return new Promise<unknown[]>((inner) => {
          unblockFirstSearch = inner;
        }) as unknown as Promise<[number, unknown]>;
      });
    });
    const unexpectedSecondSearch = nock(PROWLARR).get('/api/v1/search').query(true).reply(200, () => { searchCalls += 1; return releases; });
    nock(PROWLARR).get('/api/v1/search').query(true).reply(200, () => { searchCalls += 1; return releases; });
    nock(PROWLARR).post('/api/v1/search', grabBody).reply(201, () => { grabCalls += 1; return {}; });
    nock(PROWLARR).persist().post('/api/v1/search').reply(201, () => { grabCalls += 1; return {}; });
    await connect(llm);

    const first = callJson('ma_pick', { workKey: 'sonarr:1:s1', releaseIndex: 0 });
    const second = client.callTool({ name: 'ma_pick', arguments: { workKey: 'sonarr:1:s1', releaseIndex: 0 } });
    await firstSearchStarted;

    // First pick is parked on its search; the queued second pick must not have started at all.
    expect(unexpectedSecondSearch.isDone()).toBe(false);

    unblockFirstSearch([200, releases]);
    const firstResult = await first;
    const secondResult = await second;

    expect(unexpectedSecondSearch.isDone()).toBe(false);
    expect(firstResult.outcome).toBe('grabbed');
    expect(secondResult.isError).toBe(true);
    expect(firstText(secondResult)).toMatch(/held|queue|intent|not currently actionable/i);
    expect(llm.labels).toEqual(['planner:sonarr:1:s1']);
    expect(searchCalls).toBe(1);
    expect(grabCalls).toBe(1);
    expect(queueReads.sonarr).toBeGreaterThanOrEqual(3);
    expect(queueReads.radarr).toBeGreaterThanOrEqual(2);
  });
});

describe('stdio entry e2e (spawned process)', () => {
  /** Tiny JSON over HTTP stub: one handler serves the route table, closing tracked for teardown. */
  function startStub(handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        handle(req, res);
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
        });
      });
    });
  }

  it('spawned entry serves ma_cycle with pino output confined to stderr (protocol framing intact)', async () => {
    const sonarr = await startStub((req, res) => {
      if (req.url?.startsWith('/api/v3/queue')) return res.end(JSON.stringify(emptySonarrQueuePage));
      if (req.url?.startsWith('/api/v3/series')) return res.end(JSON.stringify([seriesFixture]));
      if (req.url?.startsWith('/api/v3/episode')) return res.end(JSON.stringify(episodesJson));
      res.end('[]');
    });
    const radarr = await startStub((req, res) => {
      if (req.url?.startsWith('/api/v3/queue')) return res.end(JSON.stringify(emptyRadarrQueuePage));
      return res.end(JSON.stringify([]));
    });
    const prowlarr = await startStub((req, res) => {
      if (req.method === 'POST') return res.end('{}');
      if (req.url?.includes('downloadclient')) return res.end(JSON.stringify(downloadClientsFixture));
      if (req.url?.includes('/indexerstatus')) return res.end('[]');
      if (req.url?.includes('/indexer')) return res.end(JSON.stringify(indexersFixture));
      return res.end(JSON.stringify([releaseFixture])); // GET /api/v1/search
    });
    // Scripted LLM: use the actual grouped JSON-Schema names sent by Planner/Picker.
    const llm = await startStub((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += String(chunk);
      });
      req.on('end', () => {
        const schemaName = JSON.parse(body).response_format?.json_schema?.name as string | undefined;
        const content = schemaName === 'group_picker_selection'
          ? '{"selection":{"verdict":"grab","releaseIndices":[0],"manualTargetIndices":[],"deferredTargetIndices":[],"reason":"best fit"}}'
          : schemaName === 'group_planner_queries'
            ? '{"queries":[{"query":"Frieren","categories":[5070],"targetIndices":[0]}]}'
            : '{}';
        res.end(JSON.stringify(llmReply(content)));
      });
    });

    const dbDir = mkdtempSync(join(tmpdir(), 'mcp-e2e-'));
    const dbPath = join(dbDir, 'state.db');
    const seed = State.open(dbPath);
    seed.saveSettings({ ...defaultSettings, integrations: {
      prowlarr: { url: prowlarr.url, apiKey: 'prowlarr-key', tvClient: 'qBit-TV', movieClient: 'qBit-Movies' },
      sonarr: { url: sonarr.url, apiKey: 'sonarr-key' }, radarr: { url: radarr.url, apiKey: 'radarr-key' },
    }, ai: { ...defaultSettings.ai, apiKey: 'llm-key', baseUrl: llm.url, model: 'stub-model' } });
    seed.close();
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/mcp/server.ts'],
      stderr: 'pipe',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env as Record<string, string>,
        PROWLARR_URL: prowlarr.url,
        PROWLARR_API_KEY: 'prowlarr-key',
        SONARR_URL: sonarr.url,
        SONARR_API_KEY: 'sonarr-key',
        RADARR_URL: radarr.url,
        RADARR_API_KEY: 'radarr-key',
        PROWLARR_CLIENT_TV: 'qBit-TV',
        PROWLARR_CLIENT_MOVIE: 'qBit-Movies',
        LLM_BASE_URL: llm.url,
        LLM_API_KEY: 'llm-key',
        LLM_MODEL: 'stub-model',
        DRY_RUN: 'true',
        DB_PATH: dbPath,
        LOG_LEVEL: 'info', // the DRY_RUN grab-intent line MUST fire — it is the corruption probe
      },
    });
    const parseErrors: Error[] = [];
    transport.onerror = (error) => parseErrors.push(error);
    const client = new Client({ name: 'mcp-e2e', version: '0.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'ma_cycle', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(firstText(result))).toEqual({
        units: 1,
        searched: 1,
        grabbed: 0,
        dryRunGrabs: 1,
        manualFlagged: 0,
        skipped: 0,
      });
      // A pino line on stdout would corrupt the JSON-RPC framing and surface here.
      expect(parseErrors).toEqual([]);
    } finally {
      await client.close();
      // Drain stderr to end BEFORE asserting: pipe scheduling is async, and a
      // same-tick read of the separately-piped stream is a flake.
      const stderrText = await new Promise<string>((resolve) => {
        const stream = transport.stderr;
        if (!stream) {
          resolve('');
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
        stream.on('error', () => resolve(Buffer.concat(chunks).toString()));
      });
      // The corruption probe actually fired: the runner's DRY_RUN intent line must be on stderr.
      expect(stderrText).toContain('DRY_RUN');
      await Promise.all([sonarr.close(), radarr.close(), prowlarr.close(), llm.close()]);
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
