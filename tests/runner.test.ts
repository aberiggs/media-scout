import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { ZodType } from 'zod';
import { Http } from '../src/http';
import { ProwlarrClient } from '../src/clients/prowlarr';
import { SonarrClient } from '../src/clients/sonarr';
import { RadarrClient } from '../src/clients/radarr';
import { State } from '../src/core/state';
import { Watcher } from '../src/core/watcher';
import { Planner, plannedQueriesSchema, type PlannedQuery } from '../src/core/planner';
import { Picker, type PickVerdict } from '../src/core/picker';
import { groupPlanEnvelopeSchema, groupSelectionEnvelopeSchema, type GroupSelection } from '../src/types/group-llm';
import { Runner, type RunnerDeps } from '../src/core/runner';
import type { WorkItem } from '../src/core/work-queue-types';
import type { LLMClient } from '../src/clients/llm';
import type { Logger } from 'pino';
import type { AssociationDecision, AssociationRequest } from '../src/core/group-types';

const PROWLARR = 'http://prowlarr.test';
const SONARR = 'http://sonarr.test';
const RADARR = 'http://radarr.test';
const KEY = 'test-key';
const NOW = new Date('2026-09-29T00:00:00Z');
const TV_CLIENT = { tv: 'qBit-TV', movie: 'qBit-Movies' };

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

const release = (overrides: Record<string, unknown> = {}) => ({ ...releaseFixture, ...overrides });

const tvSeries = (
  id: number,
  title: string,
  tvdbId: number,
  seriesType: 'anime' | 'standard' = 'anime',
) => ({ ...seriesFixture, id, tvdbId, title, seriesType, alternateTitles: [] });

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

const episodesFor = (s: { id: number; seriesType: string }) => {
  if (s.seriesType === 'anime') {
    return [
      episode(s.id, { id: s.id * 100 + 1, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'Like a Fairy Tale' }),
      episode(s.id, { id: s.id * 100 + 3, episodeNumber: 9, absoluteEpisodeNumber: 9, airDate: null }),
    ];
  }
  return [episode(s.id, { id: s.id * 100 + 1, absoluteEpisodeNumber: null, title: 'Pilot' })];
};

/** Scripted LLM: planner/picker outputs keyed by unit key (label prefix routing). */
class FakeLLM implements LLMClient {
  readonly calls: { label: string; user: string }[] = [];
  readonly planner = new Map<string, PlannedQuery[]>();
  readonly picks = new Map<string, PickVerdict>();
  readonly groupPicks = new Map<string, GroupSelection>();
  readonly throwLabels = new Set<string>();

  async json<T>(args: { system: string; user: string; schema: ZodType<T>; label: string }): Promise<T> {
    this.calls.push({ label: args.label, user: args.user });
    if (this.throwLabels.has(args.label)) throw new Error('scripted LLM failure');
    if (args.label.startsWith('planner:group:')) {
      const groupKey = args.label.slice('planner:group:'.length);
      const input = JSON.parse(args.user) as { dueTargetIndices: number[]; targets: Array<{ seasonNumber: number | null }> };
      const byTarget = new Map<number, PlannedQuery[]>();
      for (const targetIndex of input.dueTargetIndices) {
        const season = input.targets[targetIndex]?.seasonNumber;
        const key = season === null || season === undefined ? groupKey : `${groupKey}:s${season}`;
        byTarget.set(targetIndex, this.planner.get(key) ?? this.planner.get('*') ?? []);
      }
      if ([...byTarget.values()].some((queries) => queries.length === 0)) throw new Error(`no planner script for ${groupKey}`);
      const queries = [...byTarget.entries()].flatMap(([targetIndex, planned]) => planned.map((query) => ({ ...query, targetIndices: [targetIndex] })));
      return groupPlanEnvelopeSchema.parse({ queries: queries.slice(0, 3) }) as T;
    }
    if (args.label.startsWith('picker:group:')) {
      const groupKey = args.label.slice('picker:group:'.length);
      const input = JSON.parse(args.user) as { dueTargetIndices: number[]; targets: Array<{ seasonNumber: number | null }> };
      const groupPick = this.groupPicks.get(groupKey);
      if (groupPick) return groupSelectionEnvelopeSchema.parse({ selection: groupPick }) as T;
      const targetIndex = input.dueTargetIndices[0] ?? 0;
      const season = input.targets[targetIndex]?.seasonNumber;
      const key = season === null || season === undefined ? groupKey : `${groupKey}:s${season}`;
      const verdict = this.picks.get(key) ?? this.picks.get(`${groupKey}:s${season}`);
      if (!verdict) throw new Error(`no picker script for ${key}`);
      return groupSelectionEnvelopeSchema.parse({ selection: {
        verdict: verdict.verdict,
        releaseIndices: verdict.verdict === 'grab' ? [verdict.releaseIndex ?? 0] : [],
        manualTargetIndices: verdict.verdict === 'manual' ? [...input.dueTargetIndices] : [],
        deferredTargetIndices: [],
        reason: verdict.reason,
      } }) as T;
    }
    if (args.label.startsWith('planner:')) {
      const key = args.label.slice('planner:'.length);
      const queries = this.planner.get(key) ?? this.planner.get('*');
      if (!queries) throw new Error(`no planner script for ${key}`);
      return plannedQueriesSchema.parse({ queries }) as T;
    }
    if (args.label.startsWith('picker:')) {
      const key = args.label.slice('picker:'.length);
      const verdict = this.picks.get(key);
      if (!verdict) throw new Error(`no picker script for ${key}`);
      return verdict as T;
    }
    throw new Error(`unscripted LLM label: ${args.label}`);
  }

  callsFor(prefix: string) {
    return this.calls.filter((c) => c.label.startsWith(prefix));
  }
}

/** Reads raw decision rows for assertions (State exposes writes; tests read the table). */
// Named cast: State owns the DB handle privately and exposes no decision read API.
function decisionRow(state: State, workKey: string) {
  const db = (state as unknown as { db: Database.Database }).db;
  // Latest row: the retry window and grabPath read the most recent decision, so tests assert that one.
  return db
    .prepare('SELECT work_key, release_title, info_hash, verdict, grabbed FROM decisions WHERE work_key = ? ORDER BY decided_at DESC, id DESC LIMIT 1')
    .get(workKey) as
    | { work_key: string; release_title: string | null; info_hash: string | null; verdict: string; grabbed: number }
    | undefined;
}

/** State double that simulates a concurrent manualPick landing between the
 *  cycle's first retry-window check and its claim: claimUnit records a decision
 *  before acquiring the claim, so the post-claim re-check must catch it. */
class RacingState extends State {
  constructor() {
    super(new Database(':memory:'));
  }

  raceKey: string | null = null;
  claimUnit(workKey: string, at?: Date): string | null {
    if (workKey === this.raceKey) {
      this.recordDecision({ workKey, verdict: 'grab', grabbed: true }, at ?? NOW);
    }
    return super.claimUnit(workKey, at ?? new Date());
  }
}

class BackoffRacingState extends State {
  constructor() { super(new Database(':memory:')); }
  raceKey: string | null = null;
  inject = false;
  claimUnit(workKey: string, at?: Date): string | null {
    if (this.inject && workKey === this.raceKey) {
      this.inject = false;
      const now = at ?? NOW;
      const competitor = super.claimUnit(workKey, now);
      const work = this.getWorkItem(workKey);
      if (competitor && work) {
        this.finishSearch({ key: workKey, token: competitor, status: 'backoff', nextSearchAt: new Date(now.getTime() + 30 * 60_000).toISOString(), failCount: work.failCount + 1, outcome: 'concurrent-failure', now: now.toISOString() });
        this.releaseClaim(workKey, competitor);
      }
    }
    return super.claimUnit(workKey, at ?? new Date());
  }
}

class TerminalAfterAcceptedState extends State {
  constructor() { super(new Database(':memory:')); }
  private failNextRenewal = false;
  workBeforeFailure: WorkItem | null = null;
  confirmGrab(input: Parameters<State['confirmGrab']>[0]): void {
    super.confirmGrab(input); // The Prowlarr receipt and dedupe markers are durable before the fresh hasFile observation.
    const intent = this.listGrabIntents().find((candidate) => candidate.id === input.intentId) ?? null;
    const capture = intent?.coverage.find((entry) => entry.workKey === 'sonarr:1:s1');
    const prior = this.getWorkItem('sonarr:1:s1');
    if (!intent || !capture || !prior || prior.unit.kind !== 'tv' || !prior.unit.season) return;
    // Test seam: a mocked positive hasFile observation reconciles the accepted capture before the outer runner step fails.
    const terminal: WorkItem = {
      ...prior,
      status: 'fulfilled',
      missingFingerprint: JSON.stringify([prior.contentIdentity, []]),
      unit: { ...prior.unit, season: { ...prior.unit.season } },
      lastObservedAt: input.now,
    };
    this.applyWorkReconciliation({ key: prior.workKey, token: intent.ownerToken, work: terminal, intentUpdates: [{ id: intent.id, status: 'fulfilled' }] });
    this.workBeforeFailure = this.getWorkItem(prior.workKey);
    this.failNextRenewal = true;
  }
  renewClaims(input: Parameters<State['renewClaims']>[0]): boolean {
    if (this.failNextRenewal) {
      this.failNextRenewal = false;
      throw new Error('injected outer group-processing failure after terminal receipt');
    }
    return super.renewClaims(input);
  }
}

interface Stack {
  runner: Runner;
  state: State;
  llm: FakeLLM;
  /** Captured runner logger.warn payloads (error-path detection in tests). */
  warns: unknown[];
  infos: unknown[];
}

/** Test logger: silent output, captures warn payloads. */
function recordingLogger(): { logger: Logger; warns: unknown[]; infos: unknown[] } {
  const warns: unknown[] = [];
  const infos: unknown[] = [];
  const logger = {
    warn: (payload: unknown) => warns.push(payload),
    info: (payload: unknown) => infos.push(payload),
    debug: () => {},
    error: () => {},
    child: function child() { return this; },
  } as unknown as Logger;
  return { logger, warns, infos };
}

function buildStack(
  llm: FakeLLM,
  opts: {
    dryRun?: boolean;
    now?: Date;
    series?: unknown[];
    movies?: unknown[];
    downloadClients?: unknown[];
    /** Shared State — used by tests that hand a ledger across two runners (live-flip). */
    state?: State;
    clock?: () => Date;
    failureBackoffMin?: number;
    failureBackoffMaxMin?: number;
    queueGraceMin?: number;
    associator?: RunnerDeps['associator'];
  } = {},
): Stack {
  const now = opts.now ?? NOW;
  const nowFn = opts.clock ?? (() => now);
  const state = opts.state ?? State.open(':memory:');
  const { logger, warns, infos } = recordingLogger();
  const http = (baseUrl: string) => new Http({ baseUrl, apiKey: KEY });
  const sonarr = new SonarrClient(http(SONARR));
  const radarr = new RadarrClient(http(RADARR));
  const runner = new Runner({
    watcher: new Watcher({
      sonarr,
      radarr,
      now: nowFn,
      onError: (error, context) => { throw new Error(`${context}: ${String(error)}`); },
    }),
    planner: new Planner({ llm }),
    picker: new Picker({ llm }),
    associator: opts.associator,
    prowlarr: new ProwlarrClient(http(PROWLARR)),
    sonarr,
    radarr,
    state,
    config: { dryRun: opts.dryRun ?? false, minRetryHours: 6, failureBackoffMin: opts.failureBackoffMin, failureBackoffMaxMin: opts.failureBackoffMaxMin, queueGraceMin: opts.queueGraceMin },
    clientNames: TV_CLIENT,
    logger,
    now: nowFn,
  });
  return { runner, state, llm, warns, infos };
}

/** Wires the per-cycle HTTP mocks: *arr work discovery + Prowlarr download clients + indexers. */
function mockDiscovery(opts: {
  series?: unknown[];
  episodes?: Record<number, unknown[]>;
  movies?: unknown[];
  downloadClients?: unknown[];
  indexers?: unknown[];
  indexerStatuses?: unknown[];
  sonarrQueue?: { status?: number; records?: unknown[] };
  radarrQueue?: { status?: number; records?: unknown[] };
  sonarrQueueSequence?: unknown[][];
} = {}) {
  nock(SONARR).persist().get('/api/v3/series').reply(200, opts.series ?? []);
  for (const s of opts.series ?? []) {
    const series = s as { id: number; seriesType: string };
    nock(SONARR).persist().get('/api/v3/episode').query({ seriesId: series.id }).reply(200, opts.episodes?.[series.id] ?? episodesFor(series));
  }
  nock(RADARR).persist().get('/api/v3/movie').reply(200, opts.movies ?? []);
  nock(PROWLARR).get('/api/v1/downloadclient').reply(200, opts.downloadClients ?? downloadClientsFixture);
  nock(PROWLARR).get('/api/v1/indexer').reply(200, opts.indexers ?? indexersFixture);
  nock(PROWLARR).get('/api/v1/indexerstatus').reply(200, opts.indexerStatuses ?? []);
  const queueEnvelope = (records: unknown[]) => ({ page: 1, pageSize: 100, totalRecords: records.length, records });
  if (opts.sonarrQueueSequence) {
    let readIndex = 0;
    nock(SONARR).persist().get('/api/v3/queue').query(true).reply(() => {
      const records = opts.sonarrQueueSequence![Math.min(readIndex++, opts.sonarrQueueSequence!.length - 1)] ?? [];
      return [200, queueEnvelope(records)];
    });
  } else {
    nock(SONARR).persist().get('/api/v3/queue').query(true).reply(opts.sonarrQueue?.status ?? 200, queueEnvelope(opts.sonarrQueue?.records ?? []));
  }
  nock(RADARR).persist().get('/api/v3/queue').query(true).reply(opts.radarrQueue?.status ?? 200, queueEnvelope(opts.radarrQueue?.records ?? []));
}

function mockSearch(
  opts: unknown[] | { status: number; body?: unknown[]; headers?: Record<string, string>; queryIs?: (q: Record<string, unknown>) => boolean } = [],
) {
  if (Array.isArray(opts)) {
    return nock(PROWLARR).get('/api/v1/search').query(true).reply(200, opts);
  }
  return nock(PROWLARR)
    .get('/api/v1/search')
    .query((q) => opts.queryIs?.(q as Record<string, unknown>) ?? true)
    .reply(opts.status, opts.body ?? [], opts.headers);
}

const grabBody = {
  indexerId: 5,
  guid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
  downloadClientId: 1,
};

/** Parses nock's repeated-key indexerIds query value into numbers. */
function indexerIdsOf(q: Record<string, unknown>): number[] {
  const raw = q.indexerIds;
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map(Number);
  return [Number(raw)];
}

function mockGrab(body: Partial<{ indexerId: number; guid: string; downloadClientId: number }>) {
  return nock(PROWLARR).post('/api/v1/search', body).reply(201, {});
}

beforeEach(() => {
  if (!nock.isActive()) nock.activate();
  nock.disableNetConnect();
});
afterEach(() => { nock.cleanAll(); vi.restoreAllMocks(); });

describe('Runner.cycle', () => {
  it('happy grab (dryRun=false): grab body routed to the TV client, decision + hash recorded', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy season fit' });
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    const searchScope = mockSearch([release()]);
    const grabScope = mockGrab(grabBody);
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(grabScope.isDone()).toBe(true);
    expect(searchScope.isDone()).toBe(true);
    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 1, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 });
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({
      verdict: 'grab',
      grabbed: 1,
      info_hash: 'FIXTUREHASH0000000000000000000000000',
      release_title: "[SubsPlease] Frieren - Beyond Journey's End - 07 (1080p) [B7C4E4A8].mkv",
    });
    expect(state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(true);
    expect(state.hasRelease(5, grabBody.guid)).toBe(true);
    expect(state.listSearchActivity(NOW.toISOString())).toMatchObject([{ source: 'cycle', query: 'Frieren', resultCount: 1, outcome: 'success', media: [{ workKey: 'sonarr:1:s1' }] }]);
  });

  it('DRY_RUN: grabs logged only — grab endpoint never called, decision recorded, hash NOT recorded', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release()]);
    const grabScope = mockGrab({}); // exists only to prove it is NEVER hit
    const { runner, state } = buildStack(llm, { dryRun: true });

    const summary = await runner.cycle();

    expect(grabScope.isDone()).toBe(false);
    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 0, dryRunGrabs: 1, manualFlagged: 0, skipped: 0 });
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'grab', grabbed: 0 });
    // I4: dry-run must NOT poison seen_hashes — the P7 dry-run→live transition re-grabs.
    expect(state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(false);
  });

  it('keeps an accepted earlier capture terminal when a later group exception follows a fresh fulfillment observation', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show S01', categories: [5000] }]);
    llm.planner.set('sonarr:1:s2', [{ query: 'Show S02', categories: [5000] }]);
    llm.groupPicks.set('sonarr:1', { verdict: 'grab', releaseIndices: [0, 1], manualTargetIndices: [], deferredTargetIndices: [], reason: 'separate season singles' });
    const series = tvSeries(1, 'Show', 11, 'standard');
    const firstEpisode = episode(1, { id: 101, seasonNumber: 1, episodeNumber: 1 });
    const secondEpisode = episode(1, { id: 201, seasonNumber: 2, episodeNumber: 1 });
    const inventory = [firstEpisode, secondEpisode];
    const firstRelease = release({ title: 'Show S01E01 1080p', guid: 'accepted-season-one', infoHash: 'ACCEPTEDSEASONONEHASH' });
    const secondRelease = release({ title: 'Show S02E01 1080p', guid: 'season-two-never-submitted', infoHash: 'SEASONTWONEVERHASH' });
    mockDiscovery({ series: [series], episodes: { 1: inventory } });
    nock(PROWLARR).persist().get('/api/v1/search').query(true).reply(200, [firstRelease, secondRelease]);
    const state = new TerminalAfterAcceptedState();
    const acceptedGrab = mockGrab({ indexerId: 5, guid: 'accepted-season-one', downloadClientId: 1 });
    const rejectedLaterGrab = nock(PROWLARR).post('/api/v1/search', { indexerId: 5, guid: 'season-two-never-submitted', downloadClientId: 1 }).reply(201, {});
    const { runner, warns } = buildStack(llm, { state });

    const summary = await runner.cycle();

    expect(acceptedGrab.isDone()).toBe(true);
    expect(rejectedLaterGrab.isDone()).toBe(false);
    expect(summary.grabbed).toBe(1);
    expect(state.workBeforeFailure).toMatchObject({ status: 'fulfilled' });
    expect(state.getWorkItem('sonarr:1:s1'), JSON.stringify(warns)).toMatchObject({ status: 'fulfilled', unit: { season: { missing: [{ episodeId: 101 }] } } });
    expect(state.getWorkItem('sonarr:1:s2')).toMatchObject({ status: 'backoff', failCount: 1 });
    expect(state.listWorkItems()).toHaveLength(2); // both terminal and nonterminal rows remain decodable
    expect(state.listGrabIntents()).toMatchObject([{ status: 'fulfilled', coverage: [{ workKey: 'sonarr:1:s1', episodeIds: [101] }] }]);
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'grab', grabbed: 1 });
    expect(state.hasHash('ACCEPTEDSEASONONEHASH')).toBe(true);
    expect(state.hasRelease(5, 'accepted-season-one')).toBe(true);
    expect(state.hasHash('SEASONTWONEVERHASH')).toBe(false);
    expect(state.hasRelease(5, 'season-two-never-submitted')).toBe(false);
    expect(state.listManualReview()).toEqual([]);
    for (const key of ['sonarr:1:s1', 'sonarr:1:s2']) {
      const token = state.claimUnit(key, NOW);
      expect(token).not.toBeNull();
      if (token) state.releaseClaim(key, token);
    }
  });

  it('live flip: a dry-run decision never blocks the later live grab of the same release', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    const shared = State.open(':memory:');

    // Cycle 1 — dry-run: grabs by log only.
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release()]);
    const dryGrabScope = mockGrab({}); // never hit in dry-run
    const dry = buildStack(llm, { dryRun: true, state: shared });
    const first = await dry.runner.cycle();
    expect(first).toEqual({ units: 1, searched: 1, grabbed: 0, dryRunGrabs: 1, manualFlagged: 0, skipped: 0 });
    expect(dryGrabScope.isDone()).toBe(false);
    expect(shared.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(false);

    // Cycle 2 — same State, live, clock past the retry window: the release is grabbed.
    nock.cleanAll();
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    const liveSearchScope = mockSearch([release()]);
    const liveGrabScope = mockGrab(grabBody);
    const live = buildStack(llm, {
      dryRun: false,
      state: shared,
      now: new Date(NOW.getTime() + 7 * 3_600_000), // MIN_RETRY_HOURS is 6
    });
    const second = await live.runner.cycle();

    expect(liveSearchScope.isDone()).toBe(true); // re-searched, not filtered by a poisoned ledger
    expect(liveGrabScope.isDone()).toBe(true);
    expect(second).toEqual({ units: 1, searched: 1, grabbed: 1, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 });
    expect(shared.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(true);
    expect(decisionRow(shared, 'sonarr:1:s1')).toMatchObject({ verdict: 'grab', grabbed: 1 });
  });

  it('picker manual verdict: manual_review row + manual decision', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'manual', reason: 'candidates ambiguous' });
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release()]);
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 0, dryRunGrabs: 0, manualFlagged: 1, skipped: 0 });
    const rows = state.listManualReview();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workKey: 'sonarr:1:s1', reason: 'picker-manual', details: 'candidates ambiguous' });
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'manual', grabbed: 0 });
    expect(state.lastDecisionAt('sonarr:1:s1')).not.toBeNull();
  });

  it('hash dedupe, unit layer: in-window decision skips the unit before planning', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release()]);
    const { runner, state } = buildStack(llm, { dryRun: true });

    const first = await runner.cycle();
    expect(first.dryRunGrabs).toBe(1);

    nock.cleanAll();
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    const searchScope = mockSearch([release()]); // must stay pending — unit skipped pre-search

    const second = await runner.cycle();

    expect(second).toEqual({ units: 1, searched: 0, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 1 });
    expect(llm.callsFor('planner:')).toHaveLength(1); // cycle 1 only
    expect(searchScope.isDone()).toBe(false);
    // Decision (not the hash) closes the retry window — dry-run never records hashes.
    expect(state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(false);
  });

  it('hash dedupe, release layer: fresh unit with an already-seen hash drops the release, no candidates', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:2:s1', [{ query: 'Frieren', categories: [5070] }]);
    const { runner, state } = buildStack(llm, { dryRun: true });
    state.recordHash('FIXTUREHASH0000000000000000000000000', 'radarr:99');

    // Same tvdbId as the fixture release — this test is about hash dedupe, not identity.
    mockDiscovery({ series: [tvSeries(2, 'Other Anime', 368013)] });
    mockSearch([release()]);
    const grabScope = mockGrab({});

    const summary = await runner.cycle();

    expect(grabScope.isDone()).toBe(false);
    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 0, dryRunGrabs: 0, manualFlagged: 1, skipped: 1 });
    expect(llm.callsFor('picker:')).toHaveLength(0);
    expect(decisionRow(state, 'sonarr:2:s1')).toMatchObject({ verdict: 'manual', grabbed: 0 });
    expect(state.getWorkItem('sonarr:2:s1')).toMatchObject({ status: 'manual', failCount: 0, nextSearchAt: null, lastOutcome: 'no-suitable-release' });
    expect(state.listManualReview()).toMatchObject([{ reason: 'no-suitable-release' }]);
    expect(state.lastDecisionAt('sonarr:2:s1')).not.toBeNull();
  });

  it('429 with Retry-After: unit aborted, remaining queries unsent, cycle continues to the next unit', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [
      { query: 'Frieren', categories: [5070] },
      { query: 'Sousou no Frieren 07', categories: [5070] }, // must NEVER be sent
    ]);
    llm.planner.set('sonarr:2:s1', [{ query: 'Other', categories: [5070] }]);
    llm.picks.set('sonarr:2:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    mockDiscovery({ series: [tvSeries(1, 'First Anime', 111), tvSeries(2, 'Second Anime', 368013)] });
    nock(PROWLARR).get('/api/v1/indexer').reply(200, indexersFixture);
    nock(PROWLARR).get('/api/v1/indexerstatus').reply(200, []);
    const firstQuery = mockSearch({
      status: 429,
      headers: { 'Retry-After': '600' },
      queryIs: (q) => q.query === 'Frieren',
    });
    const secondQuery = mockSearch({
      status: 200,
      queryIs: (q) => q.query === 'Sousou no Frieren 07',
    });
    const otherUnitQuery = mockSearch({
      status: 200,
      body: [release()],
      queryIs: (q) => q.query === 'Other',
    });
    const grabScope = mockGrab(grabBody);
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(firstQuery.isDone()).toBe(true);
    expect(secondQuery.isDone()).toBe(false); // aborted, never sent
    expect(otherUnitQuery.isDone()).toBe(true);
    expect(grabScope.isDone()).toBe(true); // next unit still processed
    expect(summary).toEqual({ units: 2, searched: 2, grabbed: 1, dryRunGrabs: 0, manualFlagged: 0, skipped: 1 });
    expect(decisionRow(state, 'sonarr:1:s1')).toBeUndefined(); // no decision for the aborted unit
    expect(state.lastDecisionAt('sonarr:1:s1')).toBeNull();
    expect(decisionRow(state, 'sonarr:2:s1')).toMatchObject({ verdict: 'grab', grabbed: 1 });
    expect(state.listSearchActivity(NOW.toISOString()).find(({ query }) => query === 'Frieren')).toMatchObject({ source: 'cycle', resultCount: null, outcome: 'error', errorCode: 'http-429' });
    expect(state.listSearchActivity(NOW.toISOString()).find(({ query }) => query === 'Other')).toMatchObject({ source: 'cycle', resultCount: 1, outcome: 'success' });
  });

  it('429 refreshes the healthy allowlist: the next unit only queries non-cooling indexers (I5)', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.planner.set('sonarr:2:s1', [{ query: 'Other', categories: [5070] }]);
    llm.picks.set('sonarr:2:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    mockDiscovery({ series: [tvSeries(1, 'First Anime', 111), tvSeries(2, 'Second Anime', 368013)] });
    const firstQuery = mockSearch({
      status: 429,
      headers: { 'Retry-After': '600' },
      queryIs: (q) => q.query === 'Frieren',
    });
    // Post-429 refresh: indexer A (Nyaa.si, id 5) now reports a future cooldown.
    nock(PROWLARR).get('/api/v1/indexer').reply(200, indexersFixture);
    nock(PROWLARR).get('/api/v1/indexerstatus').reply(200, [
      { indexerId: 5, disabledTill: '2026-09-29T01:00:00Z' },
    ]);
    const otherUnitQuery = nock(PROWLARR)
      .get('/api/v1/search')
      .query((q) => {
        const query = q as Record<string, unknown>;
        return query.query === 'Other' && JSON.stringify(indexerIdsOf(query)) === JSON.stringify([7]);
      })
      // Realistic post-refresh release: indexerId matches the indexer actually queried (7).
      .reply(200, [release({ indexerId: 7 })]);
    const grabScope = mockGrab({ indexerId: 7, guid: grabBody.guid, downloadClientId: 1 });
    const { runner, state, warns } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(firstQuery.isDone()).toBe(true); // unit 1's batch aborted on the 429
    expect(otherUnitQuery.isDone()).toBe(true); // unit 2 searched with ONLY the still-healthy indexer
    expect(grabScope.isDone()).toBe(true);
    expect(summary).toEqual({ units: 2, searched: 2, grabbed: 1, dryRunGrabs: 0, manualFlagged: 0, skipped: 1 });
    expect(decisionRow(state, 'sonarr:1:s1')).toBeUndefined();
    expect(warns.some((w) => (w as { workKey?: string }).workKey === 'sonarr:1:s1')).toBe(true); // 429 warn kept
  });

  it('unparseable title with null infoHash still reaches the I2 review flag and is not a candidate', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([
      release({ guid: 'g-unhashable', title: 'Some.Random.Trash.Bag.mkv', infoHash: null }),
    ]);
    const grabScope = mockGrab({});
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(grabScope.isDone()).toBe(false);
    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 0, dryRunGrabs: 0, manualFlagged: 2, skipped: 1 });
    expect(state.listManualReview()).toEqual(expect.arrayContaining([
      expect.objectContaining({ workKey: 'sonarr:1:s1', reason: 'unparseable-title', details: 'Some.Random.Trash.Bag.mkv' }),
      expect.objectContaining({ workKey: 'sonarr:1:s1', reason: 'no-suitable-release' }),
    ]));
    expect(state.lastDecisionAt('sonarr:1:s1')).not.toBeNull();
  });

  it('grab-time 429 refreshes the allowlist: nothing recorded, next unit queries only healthy indexers', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.planner.set('sonarr:2:s1', [{ query: 'Other', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    llm.picks.set('sonarr:2:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    mockDiscovery({ series: [tvSeries(1, 'First Anime', 368013), tvSeries(2, 'Second Anime', 368013)] });
    const unit1Search = mockSearch({
      status: 200,
      body: [release()],
      queryIs: (q) => q.query === 'Frieren',
    });
    const unit1Grab = nock(PROWLARR).post('/api/v1/search').reply(429, {}, { 'Retry-After': '600' });
    // Post-429 refresh: indexer A (id 5) now cooling.
    nock(PROWLARR).get('/api/v1/indexer').reply(200, indexersFixture);
    nock(PROWLARR).get('/api/v1/indexerstatus').reply(200, [
      { indexerId: 5, disabledTill: '2026-09-29T01:00:00Z' },
    ]);
    const unit2Search = nock(PROWLARR)
      .get('/api/v1/search')
      .query((q) => {
        const query = q as Record<string, unknown>;
        return query.query === 'Other' && JSON.stringify(indexerIdsOf(query)) === JSON.stringify([7]);
      })
      .reply(200, [release({ indexerId: 7, guid: 'unit2-guid', infoHash: 'UNIT2HASH' })]);
    const unit2Grab = mockGrab({ indexerId: 7, guid: 'unit2-guid', downloadClientId: 1 });
    const { runner, state, warns } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(unit1Search.isDone()).toBe(true);
    expect(unit1Grab.isDone()).toBe(true);
    expect(unit2Search.isDone()).toBe(true); // refreshed allowlist: only indexer 7 queried
    expect(unit2Grab.isDone()).toBe(true);
    expect(summary).toEqual({ units: 2, searched: 2, grabbed: 1, dryRunGrabs: 0, manualFlagged: 0, skipped: 1 });
    // Grab-time 429 records NOTHING for unit 1 — it retries next cycle.
    expect(decisionRow(state, 'sonarr:1:s1')).toBeUndefined();
    expect(state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(false);
    expect(warns.some((w) => (w as { workKey?: string }).workKey === 'sonarr:1:s1')).toBe(true);
  });

  it('decision recorded between the window check and the claim → second check under the claim skips (I4 TOCTOU)', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    const searchScope = mockSearch([release()]); // must stay pending
    const grabScope = mockGrab({});
    // A concurrent manualPick finishes BETWEEN the cycle's first window check and its
    // claim: model it by recording the decision inside claimUnit (lastDecisionAt still
    // returns null at first-check time).
    const racing = new RacingState();
    racing.raceKey = 'sonarr:1:s1';
    const { runner } = buildStack(llm, { dryRun: false, state: racing });

    const summary = await runner.cycle();

    expect(summary).toEqual({ units: 1, searched: 0, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 1 });
    expect(llm.callsFor('planner:')).toHaveLength(0);
    expect(searchScope.isDone()).toBe(false);
    expect(grabScope.isDone()).toBe(false);
  });

  it('null-size release flows to the picker as an unknown, not dropped (D2 fail-open to the LLM)', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'LLM judged despite null size' });
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release({ size: null })]);
    const grabScope = mockGrab(grabBody);
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(grabScope.isDone()).toBe(true);
    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 1, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 });
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'grab', grabbed: 1 });
    expect(state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(true);
  });

  it('picker payload carries identity evidence: candidate tmdbId/tvdbId + unit year/externalIds', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release()]);
    const { runner } = buildStack(llm, { dryRun: false });

    await runner.cycle();

    const pickerCall = llm.calls.find((c) => c.label.startsWith('picker:'));
    if (!pickerCall) throw new Error('picker was not called');
    const payload = JSON.parse(pickerCall.user) as {
      targets: { year: number | null; tmdbId: number | null; tvdbId: number | null }[];
      candidates: { tmdbId: number | null; tvdbId: number | null }[];
    };
    // Group target carries externalId labeled by kind; candidate identity remains available.
    expect(payload.targets[0]?.tvdbId).toBe(368013);
    expect(payload.targets[0]?.tmdbId).toBeNull();
    expect(payload.targets[0]?.year).toBeNull();
    expect(payload.candidates[0]?.tvdbId).toBe(368013);
    expect(payload.candidates[0]?.tmdbId).toBeNull();
  });

  it('held cross-process claim: cycle skips the unit without planning (I4)', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    const searchScope = mockSearch([release()]); // must stay pending
    const { runner, state, llm: scripted } = buildStack(llm, { dryRun: false });
    expect(state.claimUnit('sonarr:1:s1', NOW)).not.toBeNull(); // another process holds it

    const summary = await runner.cycle();

    expect(summary).toEqual({ units: 1, searched: 0, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 1 });
    expect(scripted.callsFor('planner:')).toHaveLength(0);
    expect(searchScope.isDone()).toBe(false);
    expect(state.lastDecisionAt('sonarr:1:s1')).toBeNull(); // nothing recorded for a foreign claim
  });

  it('manualPick on a held cross-process claim throws in-flight without touching the foreign claim', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    const { runner, state } = buildStack(llm, { dryRun: false });
    expect(state.claimUnit('sonarr:1:s1', NOW)).not.toBeNull();

    await expect(runner.manualPick('sonarr:1:s1', 0)).rejects.toThrow(/in-flight/);
    // A denied pick neither clobbers nor releases the foreign claim.
    expect(state.claimUnit('sonarr:1:s1', NOW)).toBeNull();
  });

  it('movie cycle: Radarr unit routes the grab to the movie download client and records the hash', async () => {
    const movie = JSON.parse(
      readFileSync(new URL('./fixtures/radarr-movie.json', import.meta.url), 'utf8'),
    );
    const llm = new FakeLLM();
    llm.planner.set('radarr:3', [{ query: "Harry Potter and the Philosopher's Stone (2001)", categories: [2000] }]);
    llm.picks.set('radarr:3', { verdict: 'grab', releaseIndex: 0, reason: 'proper movie release' });
    mockDiscovery({ series: [], movies: [movie] });
    const searchScope = mockSearch([
      release({
        title: "Harry.Potter.and.the.Philosopher's.Stone.2001.1080p.BluRay.x264",
        guid: 'movie-guid-0001',
        infoHash: 'MOVIEHASH0000000000000000000000000000',
        tvdbId: null,
        tmdbId: 671,
        size: 8 * 1024 * 1024 * 1024,
        categories: [{ id: 2000, name: 'Movies' }],
      }),
    ]);
    // Movie grabs route to qBit-Movies (id 2), never the TV entry.
    const grabScope = mockGrab({ indexerId: 5, guid: 'movie-guid-0001', downloadClientId: 2 });
    const tvGrabScope = mockGrab({ indexerId: 5, guid: 'movie-guid-0001', downloadClientId: 1 });
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    // Movie-side identity evidence pin (D2): unit carries tmdbId + Radarr year,
    // tvdbId labeled null; the candidate carries its raw tmdbId. The LLM is the
    // only movie identity judge — a nulling regression here would blind it.
    const moviePickerCall = llm.calls.find((c) => c.label === 'picker:group:radarr:3');
    if (!moviePickerCall) throw new Error('movie picker was not called');
    const moviePayload = JSON.parse(moviePickerCall.user) as {
      targets: { year: number | null; tmdbId: number | null; tvdbId: number | null }[];
      candidates: { tmdbId: number | null; tvdbId: number | null; coverageBasis: string | null }[];
    };
    expect(moviePayload.targets[0]?.tmdbId).toBe(671);
    expect(moviePayload.targets[0]?.year).toBe(2001);
    expect(moviePayload.targets[0]?.tvdbId).toBeNull();
    expect(moviePayload.candidates[0]?.tmdbId).toBe(671);
    expect(moviePayload.candidates[0]?.tvdbId).toBeNull();
    expect(moviePayload.candidates[0]?.coverageBasis).toBeUndefined();

    expect(searchScope.isDone()).toBe(true);
    expect(grabScope.isDone()).toBe(true);
    expect(tvGrabScope.isDone()).toBe(false);
    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 1, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 });
    expect(decisionRow(state, 'radarr:3')).toMatchObject({
      verdict: 'grab',
      grabbed: 1,
      info_hash: 'MOVIEHASH0000000000000000000000000000',
    });
    expect(state.hasHash('MOVIEHASH0000000000000000000000000000')).toBe(true);
  });

  it('missing download client entry: grab-path pick flags manual review, grab never called', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    mockDiscovery({
      series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)],
      downloadClients: (downloadClientsFixture as { name: string }[]).filter((c) => c.name !== TV_CLIENT.tv),
    });
    mockSearch([release()]);
    const grabScope = mockGrab({});
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(grabScope.isDone()).toBe(false);
    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 0, dryRunGrabs: 0, manualFlagged: 1, skipped: 0 });
    expect(state.listManualReview()).toEqual([
      expect.objectContaining({ workKey: 'sonarr:1:s1', reason: 'missing-download-client', details: TV_CLIENT.tv }),
    ]);
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'manual', grabbed: 0 });
  });

  it('unit isolation: one planner failure never aborts the cycle', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:2:s1', [{ query: 'Other', categories: [5070] }]);
    llm.picks.set('sonarr:2:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    llm.throwLabels.add('planner:group:sonarr:1');
    mockDiscovery({ series: [tvSeries(1, 'Broken Anime', 111), tvSeries(2, 'Working Anime', 368013)] });
    mockSearch({
      status: 200,
      body: [release()],
      queryIs: (q) => q.query === 'Other',
    });
    const grabScope = mockGrab(grabBody);
    const { runner } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(grabScope.isDone()).toBe(true);
    expect(summary).toEqual({ units: 2, searched: 1, grabbed: 1, dryRunGrabs: 0, manualFlagged: 0, skipped: 1 });
  });

  it('unparseable release flagged; a good release in the same batch still grabs', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([
      release({ guid: 'g-unparseable', title: 'Some.Random.Trash.Bag.mkv', infoHash: 'HASHUNPARSEABLE00000000000000000000' }),
      release(),
    ]);
    const grabScope = mockGrab(grabBody);
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(grabScope.isDone()).toBe(true);
    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 1, dryRunGrabs: 0, manualFlagged: 1, skipped: 0 });
    expect(state.listManualReview()).toEqual([
      expect.objectContaining({ workKey: 'sonarr:1:s1', reason: 'unparseable-title', details: 'Some.Random.Trash.Bag.mkv' }),
    ]);
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'grab', grabbed: 1 });
  });

  it('malformed season labels never reach picker or grab', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Some Show', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'would grab if admitted' });
    mockDiscovery({
      series: [tvSeries(1, 'Some Show', 12345, 'standard')],
      episodes: {
        1: [2, 3, 7].map((episodeNumber) => episode(1, {
          id: 900 + episodeNumber,
          seasonNumber: 1,
          episodeNumber,
          absoluteEpisodeNumber: null,
        })),
      },
    });
    const malformedTitles = [
      'Show S01E 1080p',
      'Show S01Ebad',
      'Show S01junk',
      'Show S01/02 Complete',
      'Show S01,02 Complete',
      'Show S01;02 Complete',
      'Show S01 (E02-E01) - 07',
      'Show S01 (E02-Ebad) 1080p',
      'Show S01(E03)-(E02) - 07',
      'Show S01E03-[E02] - 07',
      'Show S01(E03)-E02 - 07',
      'Show (S01E02)-Ebad',
    ];
    mockSearch(malformedTitles.map((title, index) => release({
      guid: `g-malformed-${index}`,
      title,
      infoHash: `HASHMALFORMED${String(index).padStart(20, '0')}`,
    })));
    const grabScope = mockGrab({});
    const { runner } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(summary).toMatchObject({ grabbed: 0 });
    expect(llm.callsFor('picker:')).toHaveLength(0);
    expect(grabScope.isDone()).toBe(false);
  });

  it('preserved wrapped E02-E03 exposes only episodes 2 and 3 coverage to the picker', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Some Show', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'explicit episode match' });
    const series = tvSeries(1, 'Some Show', 12345, 'standard');
    mockDiscovery({
      series: [series],
      episodes: {
        1: [2, 3, 7].map((episodeNumber) => episode(1, {
          id: 100 + episodeNumber,
          seasonNumber: 1,
          episodeNumber,
          absoluteEpisodeNumber: null,
        })),
      },
    });
    mockSearch([release({ title: 'Show S01(E02-E03) 1080p.x265-GROUP' })]);
    const grabScope = mockGrab(grabBody);
    const { runner } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(grabScope.isDone()).toBe(true);
    expect(summary.grabbed).toBe(1);
    const pickerCall = llm.calls.find((call) => call.label === 'picker:group:sonarr:1');
    if (!pickerCall) throw new Error('picker was not called');
    const payload = JSON.parse(pickerCall.user) as { candidates: { capture: Array<{ targets: Array<{ episodeNumbers: number[]; basis: string }> }> }[] };
    expect(payload.candidates[0]).toMatchObject({ capture: [{ targets: [{ episodeNumbers: [2, 3], basis: 'explicit-episodes' }] }] });
  });

  it('empty search results: manual hold recorded, picker not called', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([]);
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 0, dryRunGrabs: 0, manualFlagged: 1, skipped: 1 });
    expect(llm.callsFor('picker:')).toHaveLength(0);
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'manual', grabbed: 0 });
    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ status: 'manual', failCount: 0, nextSearchAt: null, lastOutcome: 'no-suitable-release' });
    expect(state.lastDecisionAt('sonarr:1:s1')).not.toBeNull();
    expect(state.listManualReview()).toMatchObject([{ reason: 'no-suitable-release' }]);
  });

  it('persists no-results manual hold so an unchanged immediate second cycle makes no paid calls', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    const firstSearch = mockSearch([]);
    const stack = buildStack(llm, { dryRun: false });
    const first = await stack.runner.cycle();
    expect(firstSearch.isDone()).toBe(true);
    expect(first.searched).toBe(1);
    expect(first.manualFlagged).toBe(1);

    nock.cleanAll();
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    const repeatSearch = mockSearch([]);
    const second = await stack.runner.cycle();
    expect(second.searched).toBe(0);
    expect(llm.callsFor('planner:')).toHaveLength(1);
    expect(repeatSearch.isDone()).toBe(false);
    expect(stack.state.listManualReview()).toMatchObject([{ reason: 'no-suitable-release' }]);
  });

  it('rechecks the latest schedule under the reconciliation claim before writing or planning', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show', categories: [5000] }]);
    const state = new BackoffRacingState();
    const unit = { key: 'sonarr:1:s1', kind: 'tv' as const, arr: 'sonarr' as const, serviceId: 1, externalId: 11, title: 'Show', altTitles: [], seriesType: 'standard' as const, season: { seasonNumber: 1, missing: [{ episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot' }] } };
    const seeded: import('../src/core/work-queue-types').WorkItem = { workKey: unit.key, contentIdentity: 'sonarr:1:11:tv', missingFingerprint: 'seed-fingerprint', unit, status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null, lastObservedAt: NOW.toISOString(), lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null };
    const seedOwner = state.claimUnit(unit.key, NOW)!;
    state.applyWorkReconciliation({ key: unit.key, token: seedOwner, work: seeded, intentUpdates: [] });
    state.releaseClaim(unit.key, seedOwner);
    state.raceKey = unit.key;
    state.inject = true;
    mockDiscovery({ series: [tvSeries(1, 'Show', 11, 'standard')], episodes: { 1: [episode(1, { id: 101 })] } });
    const search = mockSearch([]);
    const stack = buildStack(llm, { state });

    const summary = await stack.runner.cycle();

    expect(stack.state.getWorkItem(unit.key)).toMatchObject({ status: 'backoff', failCount: 1, nextSearchAt: '2026-09-29T00:30:00.000Z' });
    expect(llm.callsFor('planner:')).toHaveLength(0);
    expect(search.isDone()).toBe(false);
    expect(summary.searched).toBe(0);
  });

  it('lets a newly eligible target reopen cooldown without consulting its older audit timestamp', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show', categories: [5000] }]);
    const stack = buildStack(llm);
    mockDiscovery({ series: [tvSeries(1, 'Show', 11, 'standard')], episodes: { 1: [episode(1, { id: 101 })] } });
    mockSearch([release({ title: 'Show S01E01 1080p' })]);
    llm.picks.set('sonarr:1:s1', { verdict: 'skip', reason: 'no suitable release' });
    await stack.runner.cycle();
    expect(stack.state.getWorkItem('sonarr:1:s1')?.status).toBe('cooldown');

    nock.cleanAll();
    mockDiscovery({ series: [tvSeries(1, 'Show', 11, 'standard')], episodes: { 1: [episode(1, { id: 101 }), episode(1, { id: 102, episodeNumber: 2 })] } });
    const search = mockSearch([release({ title: 'Show S01E01 1080p' })]);
    const afterNewEpisode = buildStack(llm, { state: stack.state, now: new Date(NOW.getTime() + 60_000) });
    const summary = await afterNewEpisode.runner.cycle();

    expect(summary.searched).toBe(1);
    expect(search.isDone()).toBe(true);
    expect(llm.callsFor('planner:')).toHaveLength(2);
  });

  it('does not admit or capture a future-only candidate that has no currently actionable target', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show E02', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'future episode' });
    mockDiscovery({ series: [tvSeries(1, 'Show', 11, 'standard')], episodes: { 1: [episode(1, { id: 101 }), episode(1, { id: 102, episodeNumber: 2, airDate: '2030-01-01' })] } });
    mockSearch([release({ title: 'Show S01E02 1080p' })]);
    const grab = mockGrab({});
    const stack = buildStack(llm, { dryRun: true });

    const summary = await stack.runner.cycle();

    expect(summary.dryRunGrabs).toBe(0);
    expect(llm.callsFor('picker:')).toHaveLength(0);
    expect(grab.isDone()).toBe(false);
    expect(stack.state.listGrabIntents()).toEqual([]);
  });

  it('admits mixed pack evidence for the current target but exposes and captures only that actionable episode', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show season 1', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'matching season pack' });
    mockDiscovery({ series: [tvSeries(1, 'Show', 11, 'standard')], episodes: { 1: [episode(1, { id: 101 }), episode(1, { id: 102, episodeNumber: 2, airDate: '2030-01-01' })] } });
    mockSearch([release({ title: 'Show Season 1 Complete 1080p' })]);
    mockGrab({});
    const stack = buildStack(llm, { dryRun: true });

    await stack.runner.cycle();

    const picker = llm.callsFor('picker:')[0];
    expect(picker).toBeDefined();
    const payload = JSON.parse(picker!.user) as { candidates: Array<{ capture: Array<{ targets: Array<{ episodeNumbers: number[]; basis: string }> }> }> };
    expect(payload.candidates[0]).toMatchObject({ capture: [{ targets: [{ episodeNumbers: [1], basis: 'inferred-season-pack' }] }] });
    expect(stack.state.getWorkItem('sonarr:1:s1')?.unit.season?.missing.map((item) => item.episodeId)).toEqual([101, 102]);
    expect(stack.state.listGrabIntents()).toEqual([]);
    const dryRun = stack.infos.find((entry) => (entry as { workKey?: string }).workKey === 'sonarr:1:s1') as Record<string, unknown>;
    expect(dryRun.coveredEpisodes).toEqual([1]);
  });

  it('stops the remaining units immediately when a post-429 allowlist refresh finds no healthy indexers', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'First', categories: [5000] }]);
    llm.planner.set('sonarr:2:s1', [{ query: 'Second', categories: [5000] }]);
    mockDiscovery({ series: [tvSeries(1, 'First', 11, 'standard'), tvSeries(2, 'Second', 22, 'standard')] });
    mockSearch({ status: 429, headers: { 'Retry-After': '120' }, queryIs: (query) => query.query === 'First' });
    nock(PROWLARR).get('/api/v1/indexer').reply(200, indexersFixture);
    nock(PROWLARR).get('/api/v1/indexerstatus').reply(200, [{ indexerId: 5, disabledTill: '2026-09-29T12:00:00Z' }, { indexerId: 7, disabledTill: '2026-09-29T12:00:00Z' }]);
    const unscopedSearch = mockSearch({ status: 200, body: [], queryIs: (query) => query.query === 'Second' });
    const stack = buildStack(llm);

    const summary = await stack.runner.cycle();

    expect(llm.callsFor('planner:').map((call) => call.label)).toEqual(['planner:group:sonarr:1']);
    expect(unscopedSearch.isDone()).toBe(false);
    expect(summary.searched).toBe(1);
  });

  it('applies one failed physical download once per affected episode, not once per series or poll', async () => {
    const llm = new FakeLLM();
    const series = tvSeries(1, 'Show', 11, 'standard');
    const episodes = { 1: [episode(1, { id: 101, seasonNumber: 1 }), episode(1, { id: 201, seasonNumber: 2, episodeNumber: 1 })] };
    const state = State.open(':memory:');
    const stack = buildStack(llm, { state });
    const failed101 = [{ id: 90, downloadId: 'shared-failed-job', seriesId: 1, episodeId: 101, seasonNumber: 1, status: 'failed' }];
    mockDiscovery({ series: [series], episodes, sonarrQueue: { records: failed101 }, indexers: [] });
    await stack.runner.cycle();
    const firstS1 = state.getWorkItem('sonarr:1:s1');
    const firstS2 = state.getWorkItem('sonarr:1:s2');
    expect(firstS1).toMatchObject({ status: 'backoff', failCount: 1 });
    expect(firstS2).toMatchObject({ status: 'ready', failCount: 0 });

    nock.cleanAll();
    const failed101And201 = [
      ...failed101,
      { id: 91, downloadId: 'shared-failed-job', seriesId: 1, episodeId: 201, seasonNumber: 2, status: 'failed' },
    ];
    mockDiscovery({ series: [series], episodes, sonarrQueue: { records: failed101And201 }, indexers: [] });
    await stack.runner.cycle();
    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ status: 'backoff', failCount: 1, nextSearchAt: firstS1?.nextSearchAt });
    expect(state.getWorkItem('sonarr:1:s2')).toMatchObject({ status: 'backoff', failCount: 1 });
    expect(llm.callsFor('planner:')).toHaveLength(0);

    const secondS1 = state.getWorkItem('sonarr:1:s1');
    const secondS2 = state.getWorkItem('sonarr:1:s2');
    nock.cleanAll();
    mockDiscovery({ series: [series], episodes, sonarrQueue: { records: failed101And201 }, indexers: [] });
    await stack.runner.cycle();
    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ failCount: 1, nextSearchAt: secondS1?.nextSearchAt });
    expect(state.getWorkItem('sonarr:1:s2')).toMatchObject({ failCount: 1, nextSearchAt: secondS2?.nextSearchAt });
  });

  it('keeps terminal movie intent history idempotent across repeated complete-library polls while processing new work', async () => {
    const movieBase = JSON.parse(readFileSync(new URL('./fixtures/radarr-movie.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const movieUnit = { key: 'radarr:3', kind: 'movie' as const, arr: 'radarr' as const, serviceId: 3, externalId: 671, title: 'Filed Movie', year: 2001, altTitles: [] };
    const state = State.open(':memory:');
    const terminalWork: WorkItem = { workKey: movieUnit.key, contentIdentity: 'radarr:3:671:movie', missingFingerprint: 'initial-movie', unit: movieUnit, status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null, lastObservedAt: NOW.toISOString(), lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null };
    const owner = state.claimUnit(movieUnit.key, NOW)!;
    state.applyWorkReconciliation({ key: movieUnit.key, token: owner, work: terminalWork, intentUpdates: [] });
    const intent = state.beginGrab({ key: movieUnit.key, token: owner, fingerprint: terminalWork.missingFingerprint, release: { arr: 'radarr', indexerId: 7, guid: 'completed-movie', infoHash: 'completed-movie-hash', releaseTitle: 'Movie' }, coverage: [{ workKey: movieUnit.key, episodeIds: null, basis: null }], now: NOW.toISOString(), deadline: '2026-09-29T00:30:00.000Z' });
    if (!intent.ok) throw new Error('expected historical movie intent');
    state.confirmGrab({ intentId: intent.intentId, ownerToken: owner, now: NOW.toISOString() });
    state.releaseClaim(movieUnit.key, owner);

    const llm = new FakeLLM();
    for (const key of ['radarr:4', 'radarr:5', 'radarr:6']) {
      llm.planner.set(key, [{ query: 'new movie', categories: [2000] }]);
      llm.picks.set(key, { verdict: 'skip', reason: 'no suitable release' });
    }
    const stack = buildStack(llm, { state });
    const filed = { ...movieBase, id: 3, hasFile: true };
    const missing4 = { ...movieBase, id: 4, tmdbId: 672, title: 'New Movie 4', hasFile: false };
    mockDiscovery({ movies: [filed, missing4] });
    mockSearch([release()]);
    await stack.runner.cycle();
    expect(state.listGrabIntents()[0]).toMatchObject({ status: 'fulfilled' });

    nock.cleanAll();
    const missing5 = { ...movieBase, id: 5, tmdbId: 673, title: 'New Movie 5', hasFile: false };
    mockDiscovery({ movies: [filed, missing4, missing5] });
    const secondSearch = mockSearch([release()]);
    const second = buildStack(llm, { state, now: new Date(NOW.getTime() + 60_000) });
    expect((await second.runner.cycle()).searched).toBe(1);
    expect(secondSearch.isDone()).toBe(true);

    nock.cleanAll();
    const missing6 = { ...movieBase, id: 6, tmdbId: 674, title: 'New Movie 6', hasFile: false };
    mockDiscovery({ movies: [filed, missing4, missing5, missing6] });
    const thirdSearch = mockSearch([release()]);
    const third = buildStack(llm, { state, now: new Date(NOW.getTime() + 2 * 60_000) });
    expect((await third.runner.cycle()).searched).toBe(1);
    expect(thirdSearch.isDone()).toBe(true);
    expect(state.listGrabIntents()).toMatchObject([{ status: 'fulfilled' }]);
  });

  it('unknown queue pagination blocks paid planning and preserves safe diagnostics', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, 'Show', 1)], sonarrQueue: { status: 500 } });
    const search = mockSearch([release()]);
    const { runner, state, warns } = buildStack(llm);

    const summary = await runner.cycle();

    expect(summary).toMatchObject({ units: 1, searched: 0 });
    expect(llm.callsFor('planner:')).toHaveLength(0);
    expect(search.isDone()).toBe(false);
    expect(state.getWorkQueueStatus().items[0]).toMatchObject({ safeHoldReason: 'queue-unknown' });
    expect(JSON.stringify(warns)).not.toContain('private');
  });

  it('persists a known-but-stale queue read as unknown and retains prior queue coverage in main reconciliation', async () => {
    const llm = new FakeLLM();
    const state = State.open(':memory:');
    const futureQueueAt = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    const unit = {
      key: 'sonarr:1:s1', kind: 'tv' as const, arr: 'sonarr' as const, serviceId: 1, externalId: 11,
      title: 'Show', altTitles: [], seriesType: 'standard' as const,
      season: { seasonNumber: 1, missing: [
        { episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot' },
        { episodeId: 102, episodeNumber: 2, absoluteEpisodeNumber: null, title: 'Second' },
      ] },
    };
    const work: WorkItem = {
      workKey: unit.key, contentIdentity: 'sonarr:1:11:tv',
      missingFingerprint: JSON.stringify(['sonarr:1:11:tv', [[101, 1, null, true], [102, 2, null, true]]]),
      unit, status: 'cooldown', lastSearchAt: null, nextSearchAt: futureQueueAt, failCount: 0, lastOutcome: null,
      lastObservedAt: NOW.toISOString(), lastQueueObservedAt: futureQueueAt, queueObservationKnown: true, blockedReason: null,
    };
    const seedOwner = state.claimUnit(work.workKey, NOW)!;
    state.applyWorkReconciliation({ key: work.workKey, token: seedOwner, work, intentUpdates: [] });
    const savedCoverage = [{ workKey: work.workKey, episodeIds: [102], basis: 'explicit-episodes' as const }];
    state.applyWorkQueueObservation({ key: work.workKey, token: seedOwner, observedAt: futureQueueAt, known: true, coverage: savedCoverage });
    state.releaseClaim(work.workKey, seedOwner);

    mockDiscovery({ series: [tvSeries(1, 'Show', 11, 'standard')], episodes: { 1: [episode(1, { id: 101 }), episode(1, { id: 102, episodeNumber: 2 })] } });
    const { runner } = buildStack(llm, { state });
    await runner.cycle();

    expect(state.listWorkQueueObservations()[0]).toMatchObject({ known: false, observedAt: futureQueueAt, coverage: savedCoverage });
    expect(state.getWorkItem(work.workKey)).toMatchObject({ queueObservationKnown: false, blockedReason: 'queue-unknown' });
    expect(state.getWorkQueueStatus().items[0]).toMatchObject({ queueObservationKnown: false, coveredEpisodeIds: [102], safeHoldReason: 'queue-unknown' });
  });

  it('continues paid work for an independently healthy Arr when the other source queue is unknown', async () => {
    const movie = JSON.parse(readFileSync(new URL('./fixtures/radarr-movie.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const llm = new FakeLLM();
    llm.planner.set('radarr:3', [{ query: 'Harry Potter 2001', categories: [2000] }]);
    llm.picks.set('radarr:3', { verdict: 'skip', reason: 'scripted skip' });
    mockDiscovery({ series: [tvSeries(1, 'Show', 11)], movies: [movie], sonarrQueue: { status: 500 } });
    const search = mockSearch([release({ title: 'Movie 2020', tmdbId: 671, tvdbId: null })]);
    const { runner } = buildStack(llm);

    const summary = await runner.cycle();

    expect(search.isDone()).toBe(true);
    expect(summary.searched).toBe(1);
    expect(llm.callsFor('planner:')).toHaveLength(1);
    expect(llm.callsFor('planner:')[0]?.label).toBe('planner:group:radarr:3');
  });

  it('trims a known queued episode but rejects a full-season candidate against original inventory', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show S01', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'full season pack' });
    const series = tvSeries(1, 'Show', 11, 'standard');
    mockDiscovery({
      series: [series],
      episodes: { 1: [episode(1, { id: 101 }), episode(1, { id: 102, episodeNumber: 2 })] },
      sonarrQueue: { records: [{ id: 77, downloadId: 'external-download', seriesId: 1, episodeId: 101, seasonNumber: 1, status: 'downloading' }] },
    });
    const search = mockSearch([release({ title: 'Show Season 1 Complete 1080p' })]);
    const grab = mockGrab({});
    const { runner, state } = buildStack(llm);

    const summary = await runner.cycle();

    expect(search.isDone()).toBe(true);
    expect(grab.isDone()).toBe(false);
    expect(llm.callsFor('picker:')).toHaveLength(0);
    expect(summary).toMatchObject({ searched: 1, grabbed: 0, skipped: 1 });
    expect(state.getWorkItem('sonarr:1:s1')?.unit.season?.missing.map((item) => item.episodeId)).toEqual([101, 102]);
    expect(state.getWorkQueueStatus().items[0]?.coveredEpisodeIds).toEqual([101]);
  });

  it('holds a disappeared tracked queue item for review and resumes only after its review row is resolved', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show', categories: [5000] }]);
    const series = tvSeries(1, 'Show', 11, 'standard');
    const stack = buildStack(llm);
    const inventory = [episode(1, { id: 101 }), episode(1, { id: 102, episodeNumber: 2 })];
    const firstQueue = [101, 102].map((episodeId, index) => ({ id: 77 + index, downloadId: 'vanished', seriesId: 1, episodeId, seasonNumber: 1, status: 'downloading' }));
    mockDiscovery({ series: [series], episodes: { 1: inventory }, sonarrQueue: { records: firstQueue } });
    await stack.runner.cycle();

    nock.cleanAll();
    const remainingQueue = [{ id: 78, downloadId: 'vanished', seriesId: 1, episodeId: 102, seasonNumber: 1, status: 'downloading' }];
    mockDiscovery({ series: [series], episodes: { 1: inventory }, sonarrQueue: { records: remainingQueue } });
    const blockedSearch = mockSearch([]);
    const disappeared = await stack.runner.cycle();
    expect(disappeared.searched).toBe(0);
    expect(blockedSearch.isDone()).toBe(false);
    const review = stack.state.listManualReview().find((entry) => entry.reason === 'queue-review');
    expect(review).toBeDefined();
    expect(stack.state.getWorkQueueStatus().items[0]).toMatchObject({ status: 'manual', safeHoldReason: 'queue-review', coveredEpisodeIds: [101, 102] });

    stack.state.resolveManualReview(review!.id, NOW);
    nock.cleanAll();
    mockDiscovery({ series: [series], episodes: { 1: inventory }, sonarrQueue: { records: remainingQueue } });
    mockSearch([]);
    const resolved = await stack.runner.cycle();
    expect(resolved.searched).toBe(1);
    expect(llm.callsFor('planner:')).toHaveLength(1);
  });

  it('holds an unknown POST acknowledgment durably without recording markers or retrying on an empty queue', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'candidate' });
    mockDiscovery({ series: [tvSeries(1, 'Show', 11)] });
    mockSearch([release()]);
    nock(PROWLARR).post('/api/v1/search').reply(500, 'private response body');
    const stack = buildStack(llm);

    const first = await stack.runner.cycle();
    expect(first.grabbed).toBe(0);
    expect(stack.state.listGrabIntents()).toMatchObject([{ status: 'uncertain' }]);
    expect(stack.state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(false);
    expect(stack.state.hasRelease(5, grabBody.guid)).toBe(false);

    nock.cleanAll();
    mockDiscovery({ series: [tvSeries(1, 'Show', 11)], sonarrQueue: { records: [{ id: 80, downloadId: 'unrelated-failed-job', seriesId: 1, episodeId: 101, seasonNumber: 1, status: 'failed' }] } });
    const failedJobSearch = mockSearch([release()]);
    const second = await stack.runner.cycle();
    expect(second.searched).toBe(0);
    expect(failedJobSearch.isDone()).toBe(false);
    expect(stack.state.listGrabIntents()[0]?.status).toBe('uncertain');
    expect(stack.state.getWorkItem('sonarr:1:s1')).toMatchObject({ failCount: 0, status: 'backoff', lastOutcome: 'uncertain-grab' });
    expect(llm.callsFor('planner:')).toHaveLength(1);

    nock.cleanAll();
    mockDiscovery({ series: [tvSeries(1, 'Show', 11)] });
    const repeatedSearch = mockSearch([release()]);
    const emptyQueue = await stack.runner.cycle();
    expect(emptyQueue.searched).toBe(0);
    expect(repeatedSearch.isDone()).toBe(false);
    expect(stack.state.getWorkItem('sonarr:1:s1')).toMatchObject({ failCount: 0, lastOutcome: 'uncertain-grab' });

    nock.cleanAll();
    mockDiscovery({ series: [tvSeries(1, 'Show', 11)] });
    const afterGraceSearch = mockSearch([release()]);
    const afterGrace = buildStack(llm, { state: stack.state, now: new Date(NOW.getTime() + 31 * 60_000) });
    const third = await afterGrace.runner.cycle();
    expect(third.searched).toBe(0);
    expect(afterGraceSearch.isDone()).toBe(false);
    expect(stack.state.listManualReview().some((review) => review.reason === 'queue-review')).toBe(true);
    expect(stack.state.listGrabIntents()[0]?.status).toBe('uncertain');
  });

  it('uses capped exponential error backoff and does not pay again until due', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, 'Show', 11)] });
    mockSearch({ status: 503, body: [] });
    const stack = buildStack(llm, { failureBackoffMin: 5, failureBackoffMaxMin: 12 });
    await stack.runner.cycle();
    expect(stack.state.getWorkItem('sonarr:1:s1')).toMatchObject({ status: 'backoff', failCount: 1, nextSearchAt: '2026-09-29T00:05:00.000Z' });

    nock.cleanAll();
    mockDiscovery({ series: [tvSeries(1, 'Show', 11)] });
    const earlySearch = mockSearch([]);
    await stack.runner.cycle();
    expect(earlySearch.isDone()).toBe(false);
    expect(llm.callsFor('planner:')).toHaveLength(1);
  });

  it('records a late positive POST receipt after lease expiry and intervening active observation without overwriting newer scheduling', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'candidate' });
    mockDiscovery({ series: [tvSeries(1, 'Show', 11, 'standard')], episodes: { 1: [episode(1, { id: 101 })] } });
    mockSearch([release({ title: 'Show S01E01 1080p' })]);
    let clock = NOW;
    const stack = buildStack(llm, { clock: () => clock });
    const grab = vi.spyOn(ProwlarrClient.prototype, 'grab').mockImplementation(async () => {
      clock = new Date(NOW.getTime() + 16 * 60_000);
      const token = stack.state.claimUnit('sonarr:1:s1', clock);
      if (!token) throw new Error('expected expired claim replacement');
      const current = stack.state.getWorkItem('sonarr:1:s1');
      if (!current) throw new Error('expected current work');
      stack.state.applyWorkReconciliation({
        key: 'sonarr:1:s1', token,
        work: { ...current, status: 'cooldown', nextSearchAt: '2026-09-30T00:00:00.000Z', lastObservedAt: clock.toISOString() },
        intentUpdates: [{ id: stack.state.listGrabIntents()[0]!.id, status: 'active', lastSeenAt: clock.toISOString(), queueRefs: ['download:late'] }],
      });
      stack.state.releaseClaim('sonarr:1:s1', token);
    });

    const summary = await stack.runner.cycle();

    expect(grab).toHaveBeenCalledTimes(1);
    expect(summary.grabbed).toBe(1);
    expect(stack.state.listGrabIntents()[0]).toMatchObject({ status: 'active', confirmedAt: clock.toISOString(), queueRefs: ['download:late'] });
    expect(stack.state.hasRelease(5, grabBody.guid)).toBe(true);
    expect(stack.state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(true);
    expect(stack.state.getWorkItem('sonarr:1:s1')).toMatchObject({ status: 'cooldown', nextSearchAt: '2026-09-30T00:00:00.000Z' });
    grab.mockRestore();
  });

  it('stops at the fresh queue recheck when coverage appears after search and pick', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show E01', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'candidate' });
    const series = tvSeries(1, 'Show', 11, 'standard');
    mockDiscovery({
      series: [series], episodes: { 1: [episode(1, { id: 101 })] },
      sonarrQueueSequence: [[], [{ id: 91, downloadId: 'just-appeared', seriesId: 1, episodeId: 101, seasonNumber: 1, status: 'downloading' }]],
    });
    mockSearch([release({ title: 'Show S01E01 1080p' })]);
    const grab = mockGrab({});
    const { runner, state } = buildStack(llm);

    const summary = await runner.cycle();

    expect(grab.isDone()).toBe(false);
    expect(summary).toMatchObject({ searched: 0, grabbed: 0, skipped: 1 });
    expect(state.listGrabIntents()).toEqual([]);
  });

  it('I5 allowlist: cooling indexer excluded from search indexerIds', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({
      series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)],
      indexerStatuses: [{ indexerId: 5, disabledTill: '2026-09-29T12:00:00Z' }], // future vs NOW
    });
    const searchScope = nock(PROWLARR)
      .get('/api/v1/search')
      .query((q) => {
        const ids = indexerIdsOf(q as Record<string, unknown>);
        return ids.length === 1 && ids[0] === 7; // only the healthy enabled indexer
      })
      .reply(200, []);
    const { runner } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(searchScope.isDone()).toBe(true);
    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 0, dryRunGrabs: 0, manualFlagged: 1, skipped: 1 });
  });

  it('I5 allowlist: all enabled indexers cooling → no search at all', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({
      series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)],
      indexerStatuses: [
        { indexerId: 5, disabledTill: '2026-09-29T12:00:00Z' },
        { indexerId: 7, disabledTill: '2026-09-29T12:00:00Z' },
      ],
    });
    const searchScope = mockSearch([release()]);
    const grabScope = mockGrab({});
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(searchScope.isDone()).toBe(false);
    expect(grabScope.isDone()).toBe(false);
    expect(summary).toEqual({ units: 1, searched: 0, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 1 });
    expect(llm.callsFor('planner:')).toHaveLength(0);
    expect(state.listManualReview()).toHaveLength(0);
  });

  it('unparseable-only result and no-suitable hold remain deduped across cycles', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    const { runner, state } = buildStack(llm, { dryRun: false });

    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release({ guid: 'g-unparseable', title: 'Some.Random.Trash.Bag.mkv', infoHash: 'HASHUNPARSEABLE00000000000000000000' })]);
    const first = await runner.cycle();
    expect(first).toEqual({ units: 1, searched: 1, grabbed: 0, dryRunGrabs: 0, manualFlagged: 2, skipped: 1 });

    nock.cleanAll();
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release({ guid: 'g-unparseable', title: 'Some.Random.Trash.Bag.mkv', infoHash: 'HASHUNPARSEABLE00000000000000000000' })]);
    const second = await runner.cycle();

    expect(second).toEqual({ units: 1, searched: 0, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 1 });
    const rows = state.listManualReview();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ workKey: 'sonarr:1:s1', reason: 'unparseable-title', details: 'Some.Random.Trash.Bag.mkv' }),
      expect.objectContaining({ workKey: 'sonarr:1:s1', reason: 'no-suitable-release' }),
    ]));
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'manual', grabbed: 0 });
    expect(state.lastDecisionAt('sonarr:1:s1')).not.toBeNull();
  });

  it('picker skip verdict: skipped counter incremented, decision recorded', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'skip', reason: 'dead seeds' });
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release()]);
    const grabScope = mockGrab({});
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(summary).toEqual({ units: 1, searched: 1, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 1 });
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'skip', grabbed: 0 });
    expect(state.listManualReview()).toHaveLength(0);
    expect(grabScope.isDone()).toBe(false);
    expect(state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(false);
  });

  it('same-cycle two-season dedupe: absolute pack grabbed once, second season unit drops it by hash', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.planner.set('sonarr:1:s2', [{ query: 'Frieren season 2', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    llm.picks.set('sonarr:1:s2', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    // ONE series (the fixture's tvdbId 368013), TWO season units, both missing an
    // episode inside the single absolute pack — dedupe must be release-layer.
    nock(SONARR).persist().get('/api/v3/series').reply(200, [tvSeries(1, "Frieren: Beyond Journey's End", 368013)]);
    nock(SONARR).persist().get('/api/v3/episode').query({ seriesId: 1 }).reply(200, [
      episode(1, { id: 101, seasonNumber: 1, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'S1E7' }),
      episode(1, { id: 113, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 13, title: 'S2E1' }),
    ]);
    nock(RADARR).persist().get('/api/v3/movie').reply(200, []);
    nock(SONARR).persist().get('/api/v3/queue').query(true).reply(200, { page: 1, pageSize: 100, totalRecords: 0, records: [] });
    nock(RADARR).persist().get('/api/v3/queue').query(true).reply(200, { page: 1, pageSize: 100, totalRecords: 0, records: [] });
    nock(PROWLARR).get('/api/v1/downloadclient').reply(200, downloadClientsFixture);
    nock(PROWLARR).get('/api/v1/indexer').reply(200, indexersFixture);
    nock(PROWLARR).get('/api/v1/indexerstatus').reply(200, []);
    const searchScope = nock(PROWLARR).get('/api/v1/search').query(true).twice().reply(200, [
      release({ title: '[SubsPlease] Frieren - 07-13 (1080p)' }), // covers abs 7 (s1) and abs 13 (s2)
    ]);
    const grabScope = mockGrab(grabBody); // exactly one grab interceptor: unit 2 must not grab
    const secondGrabScope = mockGrab(grabBody);
    const { runner, state, warns } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(searchScope.isDone()).toBe(true); // both interceptors consumed — unit 2 actually searched
    expect(grabScope.isDone()).toBe(true);
    expect(secondGrabScope.isDone()).toBe(false); // pack grabbed exactly once
    expect(summary).toEqual({ units: 2, searched: 1, grabbed: 1, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 });
    // Unit 2's skip comes from the no-candidates path (hasHash drop), NOT the error path:
    expect(warns.filter((w) => (w as { workKey?: string }).workKey === 'sonarr:1:s2')).toHaveLength(0);
    expect(llm.callsFor('picker:')).toHaveLength(1); // one selection per series group
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'grab', grabbed: 1 });
    expect(decisionRow(state, 'sonarr:1:s2')).toMatchObject({ verdict: 'grab', grabbed: 1 });
    expect(state.listGrabIntents()).toHaveLength(1);
    expect(state.listGrabIntents()[0]?.coverage).toEqual([
      { workKey: 'sonarr:1:s1', episodeIds: [101], basis: 'explicit-episodes' },
      { workKey: 'sonarr:1:s2', episodeIds: [113], basis: 'explicit-episodes' },
    ]);
    const db = (state as unknown as { db: Database.Database }).db;
    expect(db.prepare('SELECT COUNT(*) AS count FROM seen_hashes WHERE info_hash = ?').get('fixturehash0000000000000000000000000')).toMatchObject({ count: 1 });
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'grab', grabbed: 1 });
    expect(decisionRow(state, 'sonarr:1:s2')).toMatchObject({ verdict: 'grab', grabbed: 1 });
  });

  it('submits two selected season singles sequentially as two single-release intents', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show S01', categories: [5000] }]);
    llm.planner.set('sonarr:1:s2', [{ query: 'Show S02', categories: [5000] }]);
    llm.groupPicks.set('sonarr:1', { verdict: 'grab', releaseIndices: [0, 1], manualTargetIndices: [], deferredTargetIndices: [], reason: 'separate season singles' });
    const series = tvSeries(1, 'Show', 11, 'standard');
    const inventory = [
      episode(1, { id: 101, seasonNumber: 1, episodeNumber: 1 }),
      episode(1, { id: 201, seasonNumber: 2, episodeNumber: 1 }),
    ];
    const first = release({ title: 'Show S01E01 1080p', guid: 'season-one', infoHash: 'hash-one' });
    const second = release({ title: 'Show S02E01 1080p', guid: 'season-two', infoHash: 'hash-two' });
    mockDiscovery({ series: [series], episodes: { 1: inventory } });
    nock(PROWLARR).persist().get('/api/v1/search').query(true).reply(200, [first, second]);
    const firstGrab = nock(PROWLARR).post('/api/v1/search', { indexerId: 5, guid: 'season-one', downloadClientId: 1 }).reply(201, {});
    const secondGrab = nock(PROWLARR).post('/api/v1/search', { indexerId: 5, guid: 'season-two', downloadClientId: 1 }).reply(201, {});
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(firstGrab.isDone()).toBe(true);
    expect(secondGrab.isDone()).toBe(true);
    expect(summary).toMatchObject({ searched: 1, grabbed: 2 });
    expect(state.listGrabIntents()).toHaveLength(2);
    expect(state.listGrabIntents().map((intent) => intent.coverage).sort((left, right) => left[0]!.workKey.localeCompare(right[0]!.workKey))).toEqual([
      [{ workKey: 'sonarr:1:s1', episodeIds: [101], basis: 'explicit-episodes' }],
      [{ workKey: 'sonarr:1:s2', episodeIds: [201], basis: 'explicit-episodes' }],
    ]);
    expect(state.listSearchActivity(NOW.toISOString()).find(({ query }) => query === 'Show S01')).toMatchObject({ media: [{ workKey: 'sonarr:1:s1' }] });
    expect(state.listSearchActivity(NOW.toISOString()).find(({ query }) => query === 'Show S02')).toMatchObject({ media: [{ workKey: 'sonarr:1:s2' }] });
  });

  it('keeps the first accepted group release when the second is rejected and never reserves the third', async () => {
    const llm = new FakeLLM();
    for (const season of [1, 2, 3]) llm.planner.set(`sonarr:1:s${season}`, [{ query: `Show S0${season}`, categories: [5000] }]);
    llm.groupPicks.set('sonarr:1', { verdict: 'grab', releaseIndices: [0, 1, 2], manualTargetIndices: [], deferredTargetIndices: [], reason: 'three independent singles' });
    const series = tvSeries(1, 'Show', 11, 'standard');
    const inventory = [1, 2, 3].map((season) => episode(1, { id: season * 100 + 1, seasonNumber: season, episodeNumber: 1 }));
    const results = [1, 2, 3].map((season) => release({ title: `Show S0${season}E01 1080p`, guid: `season-${season}`, infoHash: `hash-${season}` }));
    mockDiscovery({ series: [series], episodes: { 1: inventory } });
    nock(PROWLARR).persist().get('/api/v1/search').query(true).reply(200, results);
    const firstGrab = nock(PROWLARR).post('/api/v1/search', { indexerId: 5, guid: 'season-1', downloadClientId: 1 }).reply(201, {});
    const secondReject = nock(PROWLARR).post('/api/v1/search', { indexerId: 5, guid: 'season-2', downloadClientId: 1 }).reply(400, {});
    const thirdGrab = nock(PROWLARR).post('/api/v1/search', { indexerId: 5, guid: 'season-3', downloadClientId: 1 }).reply(201, {});
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(firstGrab.isDone()).toBe(true);
    expect(secondReject.isDone()).toBe(true);
    expect(thirdGrab.isDone()).toBe(false);
    expect(summary).toMatchObject({ grabbed: 1, skipped: 1 });
    expect(state.listGrabIntents()).toHaveLength(2);
    expect(state.listGrabIntents().map((intent) => intent.status).sort()).toEqual(['awaiting-queue', 'failed'].sort());
    expect(state.hasRelease(5, 'season-1')).toBe(true);
    expect(state.hasRelease(5, 'season-2')).toBe(false);
    expect(state.hasRelease(5, 'season-3')).toBe(false);
  });

  it('uses one durable fuzzy-unrelated decision to unblock only initial queue ambiguity and reuses it after progress changes', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'safe supplied release' });
    const associationRequests: AssociationRequest[] = [];
    const associator = {
      associate: async (request: AssociationRequest): Promise<AssociationDecision[]> => {
        associationRequests.push(request);
        return [{ arr: request.arr, queueRef: request.lookup.queueRefsByIndex[0]!, outcome: 'unrelated', mediaReferences: [], workReferences: [], potentialScope: 'unknown', seasonNumber: null, episodeIds: null, basis: null, uncertainty: null }];
      },
    };
    const state = State.open(':memory:');
    const series = tvSeries(1, 'Show', 11, 'standard');
    const externalQueue = { id: 77, downloadId: 'unmapped-job', title: 'A different series S01E01', status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading', sizeleft: 123, timeleft: '00:00:45' };
    const pack = release({ title: 'Show S01E01 1080p', guid: 'group-association-pack', infoHash: 'ASSOCIATIONHASH' });
    mockDiscovery({ series: [series], sonarrQueue: { records: [externalQueue] } });
    mockSearch([pack]);
    mockGrab({ indexerId: 5, guid: 'group-association-pack', downloadClientId: 1 });
    const first = buildStack(llm, { dryRun: true, state, associator });
    const firstSummary = await first.runner.cycle();

    expect(firstSummary.dryRunGrabs).toBe(1);
    expect(associationRequests).toHaveLength(1);
    expect(state.listAssociationCache()).toHaveLength(1);

    nock.cleanAll();
    const progressedQueue = { ...externalQueue, sizeleft: 12, timeleft: '00:00:03' };
    mockDiscovery({ series: [series], sonarrQueue: { records: [progressedQueue] } });
    mockSearch([pack]);
    mockGrab({});
    const second = buildStack(llm, { dryRun: true, state, associator, now: new Date(NOW.getTime() + 6 * 3_600_000) });
    const secondSummary = await second.runner.cycle();

    expect(secondSummary.dryRunGrabs).toBe(1);
    expect(associationRequests).toHaveLength(1); // progress/time are absent from cache identity
    expect(llm.callsFor('planner:group:')).toHaveLength(2); // normal due group planning remains independent
    expect(state.listAssociationCache()).toHaveLength(1);
  });

  it('does not admit an otherwise useful pack whose extra season overlaps a live queue hold', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show season 1', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'combined seasons' });
    const series = tvSeries(1, 'Show', 11, 'standard');
    const episodes = [
      episode(1, { id: 101, seasonNumber: 1, episodeNumber: 1 }),
      episode(1, { id: 201, seasonNumber: 2, episodeNumber: 1, hasFile: true }),
    ];
    mockDiscovery({ series: [series], episodes: { 1: episodes }, sonarrQueue: { records: [{ id: 90, downloadId: 'season-two-job', seriesId: 1, episodeId: 201, seasonNumber: 2, status: 'downloading', trackedDownloadState: 'downloading' }] } });
    const search = mockSearch([release({ title: 'Show S01E01 S02E01 1080p', guid: 'combined-with-held-extra' })]);
    const { runner } = buildStack(llm, { dryRun: true });

    const summary = await runner.cycle();

    expect(search.isDone()).toBe(true);
    expect(llm.callsFor('picker:group:')).toHaveLength(0);
    expect(summary.dryRunGrabs).toBe(0);
  });

  it('keeps same-hash season variants as separate claims and never unions their contradictory evidence', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show S01', categories: [5000] }]);
    llm.planner.set('sonarr:1:s2', [{ query: 'Show S02', categories: [5000] }]);
    llm.groupPicks.set('sonarr:1', { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'one exact season variant' });
    const series = tvSeries(1, 'Show', 11, 'standard');
    const episodes = [episode(1, { id: 101, seasonNumber: 1 }), episode(1, { id: 201, seasonNumber: 2 })];
    const variants = [
      release({ title: 'Show S01E01 1080p', guid: 'same-hash-s1', infoHash: 'SAMEPHYSICALHASH' }),
      release({ title: 'Show S02E01 1080p', guid: 'same-hash-s2', infoHash: 'SAMEPHYSICALHASH' }),
    ];
    mockDiscovery({ series: [series], episodes: { 1: episodes } });
    nock(PROWLARR).persist().get('/api/v1/search').query(true).reply(200, variants);
    const grab = nock(PROWLARR).post('/api/v1/search', { indexerId: 5, guid: 'same-hash-s1', downloadClientId: 1 }).reply(201, {});
    const secondVariantGrab = nock(PROWLARR).post('/api/v1/search', { indexerId: 5, guid: 'same-hash-s2', downloadClientId: 1 }).reply(201, {});
    const { runner, state } = buildStack(llm, { dryRun: false });

    await runner.cycle();

    expect(grab.isDone()).toBe(true);
    expect(secondVariantGrab.isDone()).toBe(false);
    expect(state.listGrabIntents()).toHaveLength(1);
    expect(state.listGrabIntents()[0]?.coverage).toEqual([{ workKey: 'sonarr:1:s1', episodeIds: [101], basis: 'explicit-episodes' }]);
  });

  it('hashless URL-only matching season pack reaches the picker and dry-run log as inferred coverage', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren season 1', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'plausible fit; see https://secret.invalid/?apikey=hidden' });
    mockDiscovery({ series: [tvSeries(1, 'Frieren', 368013, 'standard')] });
    mockSearch([release({
      title: 'Frieren Season 1 1080p',
      guid: 'hashless-season-pack',
      indexerId: 5,
      infoHash: null,
      magnetUrl: null,
      downloadUrl: 'http://prowlarr.test/5/download?apikey=not-logged',
    })]);
    const grabScope = mockGrab({});
    const { runner, state, infos } = buildStack(llm, { dryRun: true });

    const summary = await runner.cycle();

    expect(llm.callsFor('picker:')).toHaveLength(1);
    const payload = JSON.parse(llm.callsFor('picker:')[0]!.user) as { candidates: { capture: Array<{ targets: Array<{ episodeNumbers: number[]; basis: string }> }> }[] };
    expect(payload.candidates[0]).toMatchObject({
      capture: [{ targets: [{ episodeNumbers: [1], basis: 'inferred-season-pack' }] }],
    });
    expect(summary.dryRunGrabs).toBe(1);
    expect(grabScope.isDone()).toBe(false);
    expect(state.hasRelease(5, 'hashless-season-pack')).toBe(false);
    expect(state.hasHash('')).toBe(false);
    const dryRunLog = infos.find((entry) => (entry as { workKey?: string }).workKey === 'sonarr:1:s1') as Record<string, unknown>;
    expect(dryRunLog).toMatchObject({ coverageBasis: 'inferred-season-pack', reason: 'plausible fit; see [redacted]' });
    expect(JSON.stringify(dryRunLog)).not.toContain('apikey');
  });

  it('wrong-season pack is rejected before the picker while explicit subsets remain exact', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5000] }]);
    mockDiscovery({ series: [tvSeries(1, 'Frieren', 368013, 'standard')] });
    mockSearch([
      release({ title: 'Frieren Season 2 1080p', guid: 'wrong-season', infoHash: null }),
      release({ title: 'Frieren S01E01 1080p', guid: 'explicit-one', infoHash: null }),
    ]);
    const { runner } = buildStack(llm, { dryRun: true });

    await runner.cycle();

    expect(llm.callsFor('picker:')).toHaveLength(1);
    const payload = JSON.parse(llm.callsFor('picker:')[0]!.user) as { candidates: { observedReleaseTitle: string; capture: Array<{ targets: Array<{ episodeNumbers: number[]; basis: string }> }> }[] };
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0]).toMatchObject({
      observedReleaseTitle: 'Frieren S01E01 1080p',
      capture: [{ targets: [{ episodeNumbers: [1], basis: 'explicit-episodes' }] }],
    });
  });

  it('successful hashless grab records source-qualified identity and blocks it after retry window expiry', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5000] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'URL-only match' });
    const state = State.open(':memory:');
    const pack = release({
      title: 'Frieren Season 1 1080p', guid: 'durable-guid', indexerId: 5,
      infoHash: null, magnetUrl: null,
      downloadUrl: 'http://prowlarr.test/5/download?apikey=hidden',
    });
    mockDiscovery({ series: [tvSeries(1, 'Frieren', 368013, 'standard')] });
    mockSearch([pack]);
    const grabScope = mockGrab({ indexerId: 5, guid: 'durable-guid', downloadClientId: 1 });
    const first = buildStack(llm, { dryRun: false, state });

    const firstSummary = await first.runner.cycle();

    expect(firstSummary.grabbed).toBe(1);
    expect(grabScope.isDone()).toBe(true);
    expect(state.hasRelease(5, 'durable-guid')).toBe(true);
    expect(state.hasHash('')).toBe(false);

    nock.cleanAll();
    mockDiscovery({ series: [tvSeries(1, 'Frieren', 368013, 'standard')] });
    const secondSearch = mockSearch([pack]);
    const secondGrab = mockGrab({});
    const second = buildStack(llm, {
      dryRun: false,
      state,
      now: new Date(NOW.getTime() + 7 * 3_600_000),
    });

    const secondSummary = await second.runner.cycle();

    expect(secondSearch.isDone()).toBe(false); // unresolved successful grab stays held after propagation grace
    expect(secondGrab.isDone()).toBe(false);
    expect(secondSummary).toMatchObject({ grabbed: 0, skipped: 1 });
    expect(llm.callsFor('picker:')).toHaveLength(1);
  });

  it('deduplicates repeated query releases by indexer+guid but retains identical guid from another indexer', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [
      { query: 'Frieren', categories: [5000] },
      { query: 'Frieren season pack', categories: [5000] },
    ]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'best source' });
    mockDiscovery({ series: [tvSeries(1, 'Frieren', 368013, 'standard')] });
    const sameSource = release({ title: 'Frieren S01E01', guid: 'shared-guid', indexerId: 5, infoHash: null });
    const otherSource = release({ title: 'Frieren S01E01', guid: 'shared-guid', indexerId: 7, infoHash: null });
    const searchScope = nock(PROWLARR).get('/api/v1/search').query(true).twice()
      .reply(200, [sameSource, sameSource, otherSource]);
    const grabScope = mockGrab({ indexerId: 5, guid: 'shared-guid', downloadClientId: 1 });
    const { runner, state, llm: scripted } = buildStack(llm, { dryRun: false });

    await runner.cycle();

    expect(searchScope.isDone()).toBe(true);
    expect(grabScope.isDone()).toBe(true);
    expect(scripted.callsFor('picker:')).toHaveLength(1);
    const payload = JSON.parse(scripted.callsFor('picker:')[0]!.user) as { candidates: unknown[] };
    expect(payload.candidates).toHaveLength(2);
    expect(state.hasRelease(5, 'shared-guid')).toBe(true);
    expect(state.hasRelease(7, 'shared-guid')).toBe(false);
  });

  it('failed grab records neither release identity nor infoHash', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    llm.picks.set('sonarr:1:s1', { verdict: 'grab', releaseIndex: 0, reason: 'healthy' });
    mockDiscovery({ series: [tvSeries(1, 'Frieren', 368013)] });
    mockSearch([release({ guid: 'failed-guid', indexerId: 5, infoHash: 'FAILEDHASH' })]);
    const failedGrab = nock(PROWLARR).post('/api/v1/search', { ...grabBody, guid: 'failed-guid' }).reply(500, {});
    const { runner, state } = buildStack(llm, { dryRun: false });

    const summary = await runner.cycle();

    expect(failedGrab.isDone()).toBe(true);
    expect(summary).toMatchObject({ grabbed: 0, skipped: 1 });
    expect(state.hasRelease(5, 'failed-guid')).toBe(false);
    expect(state.hasHash('FAILEDHASH')).toBe(false);
  });
});

describe('Runner.manualPick', () => {
  it('legacy single-item reverify persists a known-but-stale queue read as unknown and retains earlier holds', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Show S01', categories: [5000] }]);
    const series = tvSeries(1, 'Show', 11, 'standard');
    const episodes = [episode(1, { id: 101, title: 'Pilot' }), episode(1, { id: 102, episodeNumber: 2, title: 'Second' })];
    nock(SONARR).persist().get('/api/v3/series').reply(200, [series]);
    nock(SONARR).persist().get('/api/v3/episode').query({ seriesId: 1 }).reply(200, episodes);
    nock(RADARR).persist().get('/api/v3/movie').reply(200, []);
    nock(PROWLARR).get('/api/v1/downloadclient').reply(200, downloadClientsFixture);
    nock(PROWLARR).get('/api/v1/indexer').reply(200, indexersFixture);
    nock(PROWLARR).get('/api/v1/indexerstatus').reply(200, []);
    const queueEnvelope = (records: unknown[]) => ({ page: 1, pageSize: 100, totalRecords: records.length, records });
    const existing = { id: 77, downloadId: 'held-episode-102', seriesId: 1, episodeId: 102, seasonNumber: 1, status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading' };
    let queueReads = 0;
    let clock = new Date(NOW);
    nock(SONARR).persist().get('/api/v3/queue').query(true).reply(() => {
      queueReads += 1;
      if (queueReads === 1) return [200, queueEnvelope([existing])];
      // The endpoint succeeds, but this completed observation is older than the library snapshot.
      clock = new Date(NOW.getTime() - 60_000);
      return [200, queueEnvelope([])];
    });
    nock(RADARR).persist().get('/api/v3/queue').query(true).reply(200, queueEnvelope([]));
    mockSearch([release({ title: 'Show S01E01 1080p' })]);
    const grab = mockGrab({});
    const { runner, state } = buildStack(llm, { clock: () => clock });

    const result = await runner.manualPick('sonarr:1:s1', 0);

    expect(queueReads).toBe(2);
    expect(result.outcome).toBe('reverify-failed');
    expect(grab.isDone()).toBe(false);
    expect(state.listWorkQueueObservations()[0]).toMatchObject({ known: false, coverage: [{ workKey: 'sonarr:1:s1', episodeIds: [102] }] });
    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ queueObservationKnown: false, blockedReason: 'queue-unknown' });
    expect(state.getWorkQueueStatus().items[0]).toMatchObject({ queueObservationKnown: false, coveredEpisodeIds: [102], safeHoldReason: 'queue-unknown' });
  });

  it('grabs the chosen verified candidate through the chokepoint and records decision + hash', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([
      release({ title: '[SubsPlease] Frieren - 07 (1080p)', seeders: 421 }),
      release({ guid: 'second-guid', infoHash: 'SECONDHASH', title: '[Group] Frieren - 07 (720p)', seeders: 12 }),
    ]);
    const grabScope = mockGrab(grabBody);
    const { runner, state } = buildStack(llm, { dryRun: false });

    const result = await runner.manualPick('sonarr:1:s1', 0);

    expect(grabScope.isDone()).toBe(true);
    expect(result.outcome).toBe('grabbed');
    expect(result.coveredEpisodeNumbers).toEqual([7]);
    expect(result.coverageBasis).toBe('explicit-episodes');
    expect(result.releaseTitle).toContain('SubsPlease');
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'grab', grabbed: 1 });
    expect(state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(true);
    expect(state.listSearchActivity(NOW.toISOString())).toMatchObject([{ source: 'manual', query: 'Frieren', resultCount: 2, outcome: 'success', media: [{ workKey: 'sonarr:1:s1' }] }]);
  });

  it('records manualPick search failures as bounded manual activity without changing the failure behavior', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, 'Show', 11, 'standard')] });
    mockSearch({ status: 503 });
    const { runner, state } = buildStack(llm, { dryRun: false });

    await expect(runner.manualPick('sonarr:1:s1', 0)).rejects.toThrow();
    expect(state.listSearchActivity(NOW.toISOString())).toMatchObject([{ source: 'manual', query: 'Frieren', resultCount: null, outcome: 'error', errorCode: 'http-503' }]);
  });

  it('DRY_RUN manual pick logs intent without grabbing (I3 applies to human picks too)', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release()]);
    const grabScope = mockGrab(grabBody);
    const { runner, state } = buildStack(llm, { dryRun: true });

    const result = await runner.manualPick('sonarr:1:s1', 0);

    expect(grabScope.isDone()).toBe(false);
    expect(result.outcome).toBe('dry-run');
    expect(decisionRow(state, 'sonarr:1:s1')).toMatchObject({ verdict: 'grab', grabbed: 0 });
  });

  it('bypasses the retry window — an in-window unit is still manually pinnable (explicit human intent)', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release()]);
    const grabScope = mockGrab(grabBody);
    const { runner, state } = buildStack(llm, { dryRun: false });
    state.recordDecision({ workKey: 'sonarr:1:s1', verdict: 'skip', grabbed: false }, NOW);

    const result = await runner.manualPick('sonarr:1:s1', 0);

    expect(result.outcome).toBe('grabbed');
    expect(grabScope.isDone()).toBe(true);
  });

  it('throws with the valid range when releaseIndex is out of bounds', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)] });
    mockSearch([release()]);
    const { runner } = buildStack(llm);

    await expect(runner.manualPick('sonarr:1:s1', 5)).rejects.toThrow(/out of range/);
  });

  it('throws for a work key with no currently missing episodes (never grabs blind)', async () => {
    const llm = new FakeLLM();
    mockDiscovery({ series: [] });
    const { runner } = buildStack(llm);

    await expect(runner.manualPick('sonarr:99:s1', 0)).rejects.toThrow(/not currently eligible/);
  });

  it('missing download client: flags manual review and never grabs unrouted', async () => {
    const llm = new FakeLLM();
    llm.planner.set('sonarr:1:s1', [{ query: 'Frieren', categories: [5070] }]);
    mockDiscovery({ series: [tvSeries(1, "Frieren: Beyond Journey's End", 368013)], downloadClients: [] });
    mockSearch([release()]);
    const { runner, state } = buildStack(llm, { dryRun: false });

    const result = await runner.manualPick('sonarr:1:s1', 0);

    expect(result.outcome).toBe('missing-download-client');
    expect(state.listManualReview().map((r) => r.reason)).toContain('missing-download-client');
  });
});
