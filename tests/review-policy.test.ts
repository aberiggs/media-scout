import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { OpenRouter } from '@openrouter/sdk';
import { TooManyRequestsResponseError } from '@openrouter/sdk/models/errors';
import { z } from 'zod';
import { ApiError } from '../src/http';
import { OpenRouterLLM } from '../src/clients/llm';
import { Runner, type RunnerDeps } from '../src/core/runner';
import { State } from '../src/core/state';
import type { LibrarySnapshot } from '../src/core/watcher';
import type { GroupSelection } from '../src/types/group-llm';

const START = new Date('2026-09-29T00:00:00.000Z');
const releaseFixture = JSON.parse(readFileSync(new URL('./fixtures/prowlarr-release.json', import.meta.url), 'utf8')) as Record<string, unknown>;

function snapshot(at: Date): LibrarySnapshot {
  const series = {
    id: 1,
    tvdbId: 123,
    title: 'Example Show',
    monitored: true,
    alternateTitles: [],
    seriesType: 'standard',
  };
  const episode = {
    id: 101,
    seriesId: 1,
    seasonNumber: 1,
    episodeNumber: 1,
    absoluteEpisodeNumber: null,
    title: 'Pilot',
    airDate: '2020-01-01',
    monitored: true,
    hasFile: false,
  };
  return {
    observedAt: at.toISOString(),
    sonarr: { known: true, series: [{ series, known: true, episodes: [episode] }] },
    radarr: { known: true, movies: [] },
  } as unknown as LibrarySnapshot;
}

function makeRunner(options: {
  now: () => Date;
  search: ReturnType<typeof vi.fn>;
  planGroup?: ReturnType<typeof vi.fn>;
  pickGroup?: ReturnType<typeof vi.fn>;
  state?: State;
  dryRun?: boolean;
  grab?: ReturnType<typeof vi.fn>;
}) {
  const state = options.state ?? State.open(':memory:');
  const snapshotAt = () => snapshot(options.now());
  const prowlarr = {
    getDownloadClients: vi.fn(async () => [{ id: 1, name: 'qBit-TV' }]),
    getIndexers: vi.fn(async () => [{ id: 5, enable: true }]),
    getIndexerStatuses: vi.fn(async () => []),
    search: options.search,
    grab: options.grab ?? vi.fn(async () => undefined),
  };
  const loggerMock = { child: vi.fn(), warn: vi.fn(), info: vi.fn() };
  loggerMock.child.mockReturnValue(loggerMock);
  const logger = loggerMock as unknown as Logger;
  const deps: RunnerDeps = {
    watcher: { getSnapshot: vi.fn(snapshotAt) } as never,
    planner: { planGroup: options.planGroup ?? vi.fn(async ({ group }: { group: { targets: unknown[]; dueTargetIndices: number[] } }) => [
      { query: 'Example Show S01', categories: [5000], targetIndices: group.dueTargetIndices },
    ]) } as never,
    picker: { pickGroup: options.pickGroup ?? vi.fn(async (): Promise<GroupSelection> => ({
      verdict: 'skip', releaseIndices: [], manualTargetIndices: [], deferredTargetIndices: [], reason: 'no selection',
    })) } as never,
    prowlarr: prowlarr as never,
    sonarr: { getQueue: vi.fn(async () => []) } as never,
    radarr: { getQueue: vi.fn(async () => []) } as never,
    state,
    config: { dryRun: options.dryRun ?? false, minRetryHours: 6, failureBackoffMin: 5, failureBackoffMaxMin: 60 },
    clientNames: { tv: 'qBit-TV', movie: 'qBit-Movies' },
    logger,
    now: options.now,
  };
  return { runner: new Runner(deps), state, prowlarr, warnings: loggerMock.warn };
}

function rejectedRelease(overrides: Record<string, unknown> = {}) {
  return { ...releaseFixture, ...overrides };
}

function openRouterQuotaLLM(retryAfterSeconds: number) {
  const body = 'private SDK response with secret payload';
  const error = new TooManyRequestsResponseError(
    { error: { code: 429, message: body } },
    {
      request: new Request('https://openrouter.invalid/chat/completions?apikey=never-log'),
      response: new Response(body, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }),
      body,
    },
  );
  const client = { chat: { send: vi.fn(async () => { throw error; }) } } as unknown as OpenRouter;
  return { llm: new OpenRouterLLM({ client, model: 'test-model' }), body };
}

describe('runner review and retry policy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('holds no-suitable-release work once, stops paid searches, then resumes after explicit resolution', async () => {
    let now = new Date(START);
    const validButDeduplicated = rejectedRelease({ guid: 'already-seen', title: 'Example.Show.S01E01.1080p' });
    const wrongSeason = rejectedRelease({ guid: 'wrong-season', title: 'Example.Show.S02E01.1080p' });
    const search = vi.fn().mockResolvedValue([wrongSeason, validButDeduplicated]);
    const state = State.open(':memory:');
    state.recordRelease(5, 'already-seen', 'sonarr:99:s1', now);
    const { runner, prowlarr } = makeRunner({ now: () => now, search, state, dryRun: true });

    const first = await runner.cycle();

    expect(first).toMatchObject({ searched: 1, manualFlagged: 1, dryRunGrabs: 0 });
    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ status: 'manual', failCount: 0, nextSearchAt: null, lastOutcome: 'no-suitable-release' });
    const review = state.listManualReview();
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ workKey: 'sonarr:1:s1', reason: 'no-suitable-release' });
    expect(() => JSON.parse(review[0]!.details ?? '')).not.toThrow();
    expect(state.lastDecisionAt('sonarr:1:s1')).not.toBeNull();
    expect(state.listGrabIntents()).toEqual([]);
    expect(state.hasRelease(5, 'wrong-season')).toBe(false);
    expect(state.hasHash(String(releaseFixture.infoHash))).toBe(false);
    expect(prowlarr.grab).not.toHaveBeenCalled();

    const second = await runner.cycle();
    expect(second.searched).toBe(0);
    expect(search).toHaveBeenCalledTimes(1);
    expect(prowlarr.getIndexers).toHaveBeenCalledTimes(1); // no indexer lookup occurs when all work is held

    expect(state.resolveManualReview(review[0]!.id, now)).toBe(true);
    now = new Date(now.getTime() + 1_000);
    search.mockResolvedValueOnce([]);
    const resumed = await runner.cycle();
    expect(resumed.searched).toBe(1);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicit picker skip in cooldown without creating a no-suitable review', async () => {
    const now = () => new Date(START);
    const search = vi.fn().mockResolvedValue([rejectedRelease({ title: 'Example.Show.S01E01.1080p' })]);
    const pickGroup = vi.fn(async (): Promise<GroupSelection> => ({ verdict: 'skip', releaseIndices: [], manualTargetIndices: [], deferredTargetIndices: [], reason: 'not a good fit' }));
    const { runner, state } = makeRunner({ now, search, pickGroup });

    await runner.cycle();

    expect(pickGroup).toHaveBeenCalledTimes(1);
    expect(state.getWorkItem('sonarr:1:s1')?.status).toBe('cooldown');
    expect(state.listManualReview()).toEqual([]);
  });

  it('does not grab in DRY_RUN when a suitable release receives a manual picker verdict', async () => {
    const now = () => new Date(START);
    const search = vi.fn().mockResolvedValue([rejectedRelease({ title: 'Example.Show.S01E01.1080p' })]);
    const pickGroup = vi.fn(async (): Promise<GroupSelection> => ({ verdict: 'manual', releaseIndices: [], manualTargetIndices: [0], deferredTargetIndices: [], reason: 'uncertain fit' }));
    const { runner, state, prowlarr } = makeRunner({ now, search, pickGroup, dryRun: true });

    const summary = await runner.cycle();

    expect(summary.manualFlagged).toBe(1);
    expect(state.getWorkItem('sonarr:1:s1')?.status).toBe('manual');
    expect(state.listManualReview()).toMatchObject([{ reason: 'picker-manual', details: 'uncertain fit' }]);
    expect(state.listGrabIntents()).toEqual([]);
    expect(prowlarr.grab).not.toHaveBeenCalled();
  });

  it('escalates the third ordinary failure to one manual hold with safe stage diagnostics', async () => {
    let now = new Date(START);
    const secretLikeMessage = 'authorization=do-not-store https://indexer.invalid/search?apikey=never-store response-body=private';
    const search = vi.fn().mockRejectedValue(new Error(secretLikeMessage));
    const { runner, state } = makeRunner({ now: () => now, search });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const summary = await runner.cycle();
      expect(summary.manualFlagged).toBe(attempt === 2 ? 1 : 0);
      const work = state.getWorkItem('sonarr:1:s1');
      expect(work?.failCount).toBe(attempt + 1);
      if (attempt < 2) {
        expect(work?.status).toBe('backoff');
        now = new Date(Date.parse(work!.nextSearchAt!) + 1);
      }
    }

    const work = state.getWorkItem('sonarr:1:s1');
    expect(work).toMatchObject({ status: 'manual', failCount: 3, nextSearchAt: null, lastOutcome: 'repeated-operation-failure' });
    const reviews = state.listManualReview();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.reason).toBe('repeated-operation-failure');
    const details = JSON.parse(reviews[0]?.details ?? '{}') as Record<string, unknown>;
    expect(details).toMatchObject({ stage: 'search', errorCode: 'operation-failed', errorType: 'Error' });
    expect(JSON.stringify(details)).not.toContain(secretLikeMessage);
    expect(JSON.stringify(details)).not.toContain('apikey');
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('does not escalate repeated rate limits and honors Retry-After longer than exponential backoff', async () => {
    let now = new Date(START);
    const search = vi.fn().mockRejectedValue(new ApiError(429, 'https://prowlarr.invalid/?apikey=private', 'private body', 900));
    const { runner, state, warnings } = makeRunner({ now: () => now, search });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runner.cycle();
      const work = state.getWorkItem('sonarr:1:s1')!;
      expect(work.status).toBe('backoff');
      const exponentialSeconds = Math.min(60, 5 * 2 ** attempt) * 60;
      expect(work.nextSearchAt).toBe(new Date(now.getTime() + Math.max(exponentialSeconds, 900) * 1_000).toISOString());
      now = new Date(Date.parse(work.nextSearchAt!) + 1);
    }

    expect(state.getWorkItem('sonarr:1:s1')?.failCount).toBe(3);
    expect(state.listManualReview()).toEqual([]);
    expect(search).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('apikey=private');
    expect(warnings.mock.calls.some(([payload]) => (payload as { status?: number; retryAfterSeconds?: number }).status === 429 && (payload as { retryAfterSeconds?: number }).retryAfterSeconds === 900)).toBe(true);
  });

  it.each([
    ['quota, quota, ordinary', [429, 429, 503]],
    ['ordinary, quota, ordinary', [503, 429, 503]],
  ])('tracks only consecutive ordinary failures (%s)', async (_label, statuses) => {
    let now = new Date(START);
    const search = vi.fn();
    for (const status of statuses) search.mockRejectedValueOnce(status === 429
      ? new ApiError(429, 'https://prowlarr.invalid/?apikey=private', 'private body', 600)
      : new ApiError(503, 'https://prowlarr.invalid/?apikey=private', 'private body'));
    const { runner, state } = makeRunner({ now: () => now, search });

    for (let attempt = 0; attempt < statuses.length; attempt += 1) {
      await runner.cycle();
      const work = state.getWorkItem('sonarr:1:s1')!;
      expect(work.status).toBe('backoff');
      if (attempt < statuses.length - 1) now = new Date(Date.parse(work.nextSearchAt!) + 1);
    }

    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ failCount: 1, lastOutcome: 'operation-failure', status: 'backoff' });
    expect(state.listManualReview()).toEqual([]);
  });

  it('starts a fresh ordinary streak after unrelated durable queue failure history', async () => {
    let now = new Date(START.getTime() + 60 * 60_000);
    const state = State.open(':memory:');
    const unit = { key: 'sonarr:1:s1', kind: 'tv' as const, arr: 'sonarr' as const, serviceId: 1, externalId: 123, title: 'Example Show', altTitles: [], seriesType: 'standard' as const, season: { seasonNumber: 1, missing: [{ episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot' }] } };
    const work = { workKey: unit.key, contentIdentity: 'sonarr:1:123:tv', missingFingerprint: 'old-fingerprint', unit, status: 'backoff' as const, lastSearchAt: START.toISOString(), nextSearchAt: START.toISOString(), failCount: 8, lastOutcome: 'queue-failed', lastObservedAt: START.toISOString(), lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null };
    const seed = state.claimUnit(unit.key, START)!;
    state.applyWorkReconciliation({ key: unit.key, token: seed, work, intentUpdates: [] });
    state.releaseClaim(unit.key, seed);
    const search = vi.fn().mockRejectedValue(new Error('transient failure'));
    const { runner } = makeRunner({ now: () => now, search, state });

    await runner.cycle();

    expect(state.getWorkItem(unit.key)).toMatchObject({ status: 'backoff', failCount: 1, lastOutcome: 'operation-failure' });
    expect(state.listManualReview()).toEqual([]);
  });

  it.each(['planner', 'picker'])('normalizes actual OpenRouter quota errors for %s calls and keeps retry metadata safe', async (stage) => {
    let now = new Date(START);
    const { llm, body } = openRouterQuotaLLM(7_200);
    const callSdk = () => llm.json({ system: 'sys', user: 'user', schema: z.object({ ok: z.boolean() }), label: stage });
    const search = vi.fn().mockResolvedValue([rejectedRelease({ title: 'Example.Show.S01E01.1080p' })]);
    const planGroup = vi.fn(async () => callSdk());
    const pickGroup = vi.fn(async () => callSdk() as never);
    const { runner, state, warnings } = makeRunner({ now: () => now, search, planGroup: stage === 'planner' ? planGroup : undefined, pickGroup: stage === 'picker' ? pickGroup : undefined });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runner.cycle();
      const work = state.getWorkItem('sonarr:1:s1')!;
      expect(work.status).toBe('backoff');
      expect(work.nextSearchAt).toBe(new Date(now.getTime() + 7_200_000).toISOString());
      now = new Date(Date.parse(work.nextSearchAt!) + 1);
    }

    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ lastOutcome: 'rate-limited' });
    expect(state.listManualReview()).toEqual([]);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(body);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('apikey');
    expect(warnings.mock.calls.some(([payload]) => (payload as { status?: number; retryAfterSeconds?: number; errorType?: string }).status === 429 && (payload as { retryAfterSeconds?: number; errorType?: string }).retryAfterSeconds === 7_200 && (payload as { errorType?: string }).errorType === 'ApiError')).toBe(true);
  });

  it('escalates repeated definitive non-quota grab rejections without double-counting State.rejectGrab', async () => {
    let now = new Date(START);
    const search = vi.fn().mockResolvedValue([rejectedRelease({ title: 'Example.Show.S01E01.1080p' })]);
    const pickGroup = vi.fn(async (): Promise<GroupSelection> => ({ verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'selected' }));
    const grab = vi.fn().mockRejectedValue(new ApiError(400, 'https://prowlarr.invalid/?apikey=private', 'private response'));
    const { runner, state } = makeRunner({ now: () => now, search, pickGroup, grab });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const summary = await runner.cycle();
      const work = state.getWorkItem('sonarr:1:s1')!;
      expect(work.failCount).toBe(attempt + 1);
      expect(summary.manualFlagged).toBe(attempt === 2 ? 1 : 0);
      if (attempt < 2) now = new Date(Date.parse(work.nextSearchAt!) + 1);
    }

    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ status: 'manual', failCount: 3, lastOutcome: 'repeated-operation-failure' });
    expect(state.listManualReview()).toMatchObject([{ reason: 'repeated-operation-failure' }]);
    expect(state.listGrabIntents().every((intent) => intent.status === 'failed')).toBe(true);
    expect(state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(false);
  });

  it('keeps repeated grab-time quota rejections on the rate-limit streak', async () => {
    let now = new Date(START);
    const search = vi.fn().mockResolvedValue([rejectedRelease({ title: 'Example.Show.S01E01.1080p' })]);
    const pickGroup = vi.fn(async (): Promise<GroupSelection> => ({ verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'selected' }));
    const grab = vi.fn().mockRejectedValue(new ApiError(429, 'https://prowlarr.invalid/?apikey=private', 'private response', 1_800));
    const { runner, state } = makeRunner({ now: () => now, search, pickGroup, grab });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runner.cycle();
      const work = state.getWorkItem('sonarr:1:s1')!;
      expect(work.status).toBe('backoff');
      expect(work.nextSearchAt).toBe(new Date(now.getTime() + 1_800_000).toISOString());
      now = new Date(Date.parse(work.nextSearchAt!) + 1);
    }

    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ failCount: 3, lastOutcome: 'rate-limited' });
    expect(state.listManualReview()).toEqual([]);
    expect(state.listGrabIntents().every((intent) => intent.status === 'failed')).toBe(true);
    expect(state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(false);
  });

  it('does not turn an uncertain submitted intent into an ordinary escalation', async () => {
    let now = new Date(START);
    const search = vi.fn().mockResolvedValue([rejectedRelease({ title: 'Example.Show.S01E01.1080p' })]);
    const pickGroup = vi.fn(async (): Promise<GroupSelection> => ({ verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'selected' }));
    const grab = vi.fn().mockRejectedValue(new ApiError(500, 'https://prowlarr.invalid/?apikey=private', 'private response'));
    const { runner, state } = makeRunner({ now: () => now, search, pickGroup, grab });
    const seed = state.claimUnit('sonarr:1:s1', START)!;
    const unit = { key: 'sonarr:1:s1', kind: 'tv' as const, arr: 'sonarr' as const, serviceId: 1, externalId: 123, title: 'Example Show', altTitles: [], seriesType: 'standard' as const, season: { seasonNumber: 1, missing: [{ episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot' }] } };
    const prior = { workKey: unit.key, contentIdentity: 'sonarr:1:123:tv', missingFingerprint: 'old-fingerprint', unit, status: 'backoff' as const, lastSearchAt: START.toISOString(), nextSearchAt: START.toISOString(), failCount: 2, lastOutcome: 'operation-failure', lastObservedAt: START.toISOString(), lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null };
    state.applyWorkReconciliation({ key: unit.key, token: seed, work: prior, intentUpdates: [] });
    state.releaseClaim(unit.key, seed);

    await runner.cycle();

    expect(state.listGrabIntents()).toMatchObject([{ status: 'uncertain' }]);
    expect(state.listManualReview()).toEqual([]);
    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ status: 'backoff', failCount: 2, lastOutcome: 'uncertain-grab' });
    expect(state.hasHash('FIXTUREHASH0000000000000000000000000')).toBe(false);
  });

  it('does not create a no-suitable review or audit decision after the work claim is replaced', async () => {
    let now = new Date(START);
    const state = State.open(':memory:');
    let successor: ReturnType<State['claimUnits']> = null;
    const search = vi.fn(async () => {
      now = new Date(now.getTime() + 16 * 60_000);
      successor = state.claimUnits({ keys: ['group:sonarr:1', 'sonarr:1:s1'], now });
      return [];
    });
    const { runner } = makeRunner({ now: () => now, search, state });

    const summary = await runner.cycle();

    expect(successor).not.toBeNull();
    expect(summary.manualFlagged).toBe(0);
    expect(state.listManualReview()).toEqual([]);
    expect(state.lastDecisionAt('sonarr:1:s1')).toBeNull();
    expect(state.getWorkItem('sonarr:1:s1')?.status).toBe('searching');
    expect(state.claimUnit('sonarr:1:s1', now)).toBeNull();
    if (successor) state.releaseClaims(successor);
  });

  it('does not create repeated-failure review or overwrite a successor claim after lease expiry', async () => {
    let now = new Date(START);
    const state = State.open(':memory:');
    let successor: ReturnType<State['claimUnits']> = null;
    let count = 0;
    const search = vi.fn(async () => {
      count += 1;
      if (count === 3) {
        now = new Date(now.getTime() + 16 * 60_000);
        successor = state.claimUnits({ keys: ['group:sonarr:1', 'sonarr:1:s1'], now });
      }
      throw new Error('search failed');
    });
    const { runner } = makeRunner({ now: () => now, search, state });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runner.cycle();
      if (attempt < 2) {
        const work = state.getWorkItem('sonarr:1:s1')!;
        now = new Date(Date.parse(work.nextSearchAt!) + 1);
      }
    }

    expect(successor).not.toBeNull();
    expect(state.listManualReview()).toEqual([]);
    expect(state.lastDecisionAt('sonarr:1:s1')).toBeNull();
    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ status: 'searching', failCount: 2, lastOutcome: 'operation-failure' });
    expect(state.claimUnit('sonarr:1:s1', now)).toBeNull();
    if (successor) state.releaseClaims(successor);
  });

  it('includes safe HTTP status metadata for a repeated ordinary HTTP failure', async () => {
    let now = new Date(START);
    const search = vi.fn().mockRejectedValue(new ApiError(503, 'https://private.invalid/?apikey=secret', 'secret response body'));
    const { runner, state } = makeRunner({ now: () => now, search });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runner.cycle();
      const work = state.getWorkItem('sonarr:1:s1')!;
      if (attempt < 2) now = new Date(Date.parse(work.nextSearchAt!) + 1);
    }

    const review = state.listManualReview()[0];
    const details = JSON.parse(review?.details ?? '{}') as Record<string, unknown>;
    expect(details).toMatchObject({ stage: 'search', errorCode: 'http-503', errorType: 'ApiError', status: 503 });
    expect(JSON.stringify(details)).not.toContain('private.invalid');
    expect(JSON.stringify(details)).not.toContain('secret response body');
  });

  it.each([
    ['planner', 'planner'],
    ['picker', 'picker'],
  ])('records safe %s-stage diagnostics after repeated failures', async (operation, expectedStage) => {
    let now = new Date(START);
    const privateText = 'Bearer super-secret http://private.invalid/?apikey=secret response-body=not-for-logs';
    const search = vi.fn().mockResolvedValue([rejectedRelease({ title: 'Example.Show.S01E01.1080p' })]);
    const planGroup = vi.fn(async () => { throw new Error(privateText); });
    const pickGroup = vi.fn(async (): Promise<GroupSelection> => { throw new Error(privateText); });
    const { runner, state } = makeRunner({ now: () => now, search, planGroup: operation === 'planner' ? planGroup : undefined, pickGroup: operation === 'picker' ? pickGroup : undefined });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runner.cycle();
      const work = state.getWorkItem('sonarr:1:s1')!;
      if (attempt < 2) now = new Date(Date.parse(work.nextSearchAt!) + 1);
    }

    const review = state.listManualReview().find((row) => row.reason === 'repeated-operation-failure');
    expect(review).toBeDefined();
    const details = JSON.parse(review!.details ?? '{}') as Record<string, unknown>;
    expect(details).toMatchObject({ stage: expectedStage, errorCode: 'operation-failed', errorType: 'Error' });
    expect(JSON.stringify(details)).not.toContain(privateText);
    expect(JSON.stringify(details)).not.toContain('apikey');
  });

  it('logs an outer context-stage failure without exposing the error message', async () => {
    const privateText = 'credential=private http://private.invalid/?apikey=secret';
    const search = vi.fn().mockResolvedValue([]);
    const { runner, state, warnings } = makeRunner({ now: () => new Date(START), search });
    const listIntents = state.listGrabIntents.bind(state);
    let reads = 0;
    vi.spyOn(state, 'listGrabIntents').mockImplementation(() => {
      reads += 1;
      if (reads === 4) throw new Error(privateText);
      return listIntents();
    });

    await runner.cycle();

    expect(state.getWorkItem('sonarr:1:s1')).toMatchObject({ status: 'backoff', failCount: 1 });
    expect(warnings).toHaveBeenCalledWith(expect.objectContaining({ stage: 'context', errorCode: 'operation-failed' }), 'group processing failed; continuing cycle');
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(privateText);
  });
});
