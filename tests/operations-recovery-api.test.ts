import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { buildApp } from '../src/daemon';
import { OperatorActions } from '../src/core/operator-actions';
import { State } from '../src/core/state';
import type { Config } from '../src/config';
import type { Stack } from '../src/compose';
import type { Episode, Series, SonarrQueueRecord } from '../src/types/sonarr';
import type { WorkItem } from '../src/core/work-queue-types';
import type { LibrarySnapshot } from '../src/core/watcher';
import { defaultSettings, type Settings } from '../src/settings';

const NOW = '2026-10-01T00:00:00.000Z';
const DEADLINE = '2026-10-01T00:30:00.000Z';
const ACTION_AT = '2026-10-01T00:31:00.000Z';
const RELEASE_ACK = 'I inspected the download client(s), including routing used at submission; no matching download is active, and I authorize releasing this reservation so retries may become eligible.';
const resources: Array<{ app: Awaited<ReturnType<typeof buildApp>>; state: State }> = [];

function makeConfig(settings: Settings): Config {
  const config = {
    PROWLARR_URL: 'http://prowlarr.test', PROWLARR_API_KEY: 'p-key', SONARR_URL: 'http://sonarr.test', SONARR_API_KEY: 's-key',
    RADARR_URL: 'http://radarr.test', RADARR_API_KEY: 'r-key', PROWLARR_CLIENT_TV: 'tv', PROWLARR_CLIENT_MOVIE: 'movie',
    LLM_BASE_URL: 'http://llm.test', LLM_API_KEY: 'llm-key', LLM_MODEL: 'model', MEDIA_PREFERENCES: '', CYCLE_INTERVAL_MIN: 5,
    MIN_RETRY_HOURS: 6, FAILURE_BACKOFF_MIN: 5, FAILURE_BACKOFF_MAX_MIN: 60, QUEUE_GRACE_MIN: 30, DRY_RUN: true,
    ALLOW_OPERATOR_ACTIONS: settings.safety.allowOperatorActions, DB_PATH: ':memory:', HTTP_PORT: 7877, HTTP_HOST: '127.0.0.1', LOG_LEVEL: 'silent', settings,
  };
  return config as Config;
}

function episode(id: number, seasonNumber: number): Episode {
  return { id, seriesId: 4, seasonNumber, episodeNumber: 1, absoluteEpisodeNumber: null, title: `Episode ${id}`, airDate: '2020-01-01', monitored: true, hasFile: false };
}
function series(): Series {
  return { id: 4, tvdbId: 44, title: 'Show', titleSlug: 'show', seriesType: 'standard', monitored: true, seasons: [{ seasonNumber: 1, monitored: true, statistics: null }, { seasonNumber: 2, monitored: true, statistics: null }], alternateTitles: [] };
}
function work(season: number, episodeId: number): WorkItem {
  const key = `sonarr:4:s${season}`;
  return {
    workKey: key, contentIdentity: 'sonarr:4:44:tv', missingFingerprint: `fingerprint-${episodeId}`,
    unit: { key, kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [], seriesType: 'standard', season: { seasonNumber: season, missing: [{ episodeId, episodeNumber: 1, absoluteEpisodeNumber: null, title: `Episode ${episodeId}` }] } },
    status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null,
    lastObservedAt: NOW, lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null,
  };
}
function librarySnapshot(episodes: Episode[]): LibrarySnapshot {
  return { observedAt: ACTION_AT, sonarr: { known: true, series: [{ series: series(), known: true, episodes }] }, radarr: { known: true, movies: [] } };
}
const associationQueue = (): SonarrQueueRecord[] => [{
  id: 22, downloadId: 'job-1', title: 'Show.S01E01', status: 'downloading', trackedDownloadStatus: null, trackedDownloadState: 'downloading',
  seriesId: null, episodeId: null, seasonNumber: null,
} as SonarrQueueRecord];

function apiFixture(options: { enabled?: boolean; initialQueue?: SonarrQueueRecord[]; snapshot?: LibrarySnapshot; clock?: { value: string } } = {}) {
  const enabled = options.enabled ?? true;
  let settings: Settings = { ...defaultSettings, safety: { ...defaultSettings.safety, allowOperatorActions: enabled } };
  const state = State.open(':memory:');
  state.saveSettings(settings);
  const readCounts = { snapshot: 0, sonarrQueue: 0, radarrQueue: 0 };
  let currentSnapshot = options.snapshot ?? librarySnapshot([episode(101, 1)]);
  let currentQueue = options.initialQueue ?? associationQueue();
  const watcher = { getSnapshot: vi.fn(async () => { readCounts.snapshot += 1; return currentSnapshot; }) };
  const sonarr = { getQueue: vi.fn(async () => { readCounts.sonarrQueue += 1; return currentQueue; }) };
  const radarr = { getQueue: vi.fn(async () => { readCounts.radarrQueue += 1; return [] as never[]; }) };
  const clock = options.clock ?? { value: ACTION_AT };
  const makeActions = (current: Settings) => new OperatorActions({ enabled: current.safety.allowOperatorActions, config: makeConfig(current), state, watcher: watcher as never, sonarr: sonarr as never, radarr: radarr as never, now: () => new Date(clock.value) });
  const bootstrapConfig = makeConfig(settings);
  const stack = {
    config: bootstrapConfig, state,
    runner: { cycle: async () => ({ units: 0, searched: 0, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 }) },
    logger: pino({ level: 'silent' }),
  } as unknown as Stack;
  stack.createSnapshot = (next) => { settings = next; return { ...stack, operatorActions: makeActions(next) } as Stack; };
  return buildApp(stack).then((app) => {
    resources.push({ app, state });
    return { app, state, watcher, sonarr, radarr, readCounts, clock, setQueue: (queue: SonarrQueueRecord[]) => { currentQueue = queue; }, setSnapshot: (snapshot: LibrarySnapshot) => { currentSnapshot = snapshot; }, setSettings: (next: Settings) => { settings = next; state.saveSettings(next); }, getSettings: () => settings };
  });
}

async function seedAssociation(state: State): Promise<number> {
  const item = work(1, 101);
  const owner = state.claimUnit(item.workKey, new Date(NOW))!;
  state.applyWorkReconciliation({ key: item.workKey, token: owner, work: item, intentUpdates: [] });
  state.releaseClaim(item.workKey, owner);
  state.flagManualReview(item.workKey, 'queue-review', undefined, new Date(ACTION_AT));
  return state.listManualReview()[0]!.id;
}

async function seedMultiWorkRelease(state: State): Promise<{ reviewId: number; intentId: string }> {
  const first = work(1, 101);
  const second = work(2, 201);
  const keys = [first.workKey, second.workKey, 'group:sonarr:4'];
  const claims = state.claimUnits({ keys, now: new Date(NOW) })!;
  state.applyWorkReconciliation({ key: first.workKey, token: claims.ownerToken, work: first, intentUpdates: [] });
  state.applyWorkReconciliation({ key: second.workKey, token: claims.ownerToken, work: second, intentUpdates: [] });
  const reservation = state.beginGroupGrab({
    claims, fingerprints: { [first.workKey]: first.missingFingerprint, [second.workKey]: second.missingFingerprint },
    release: { arr: 'sonarr', indexerId: 4, guid: 'multi-season', infoHash: null, releaseTitle: 'Show.S01-S02' },
    coverage: [
      { workKey: first.workKey, episodeIds: [101], basis: 'explicit-episodes' },
      { workKey: second.workKey, episodeIds: [201], basis: 'explicit-episodes' },
    ],
    declaredScope: { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: null }, { seasonNumber: 2, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false },
    now: NOW, deadline: DEADLINE,
  });
  if (!reservation.ok) throw new Error(`test reservation failed: ${reservation.reason}`);
  state.markGrabUncertain({ intentId: reservation.intentId, ownerToken: claims.ownerToken, now: DEADLINE });
  state.releaseClaims({ keys: claims.keys, ownerToken: claims.ownerToken });
  state.flagManualReviewLinked({ workKey: first.workKey, reason: 'queue-review', intentId: reservation.intentId, at: new Date(ACTION_AT) });
  return { reviewId: state.listManualReview()[0]!.id, intentId: reservation.intentId };
}

afterEach(async () => { for (const resource of resources.splice(0)) { await resource.app.close(); resource.state.close(); } });

describe('operations recovery HTTP integration', () => {
  it('disabled prepare/commit rejects before external reads and leaves durable state unchanged', async () => {
    const { app, state, readCounts } = await apiFixture({ enabled: false });
    const reviewId = await seedAssociation(state);
    const before = { ...readCounts };
    const prepare = await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/prepare`, payload: { action: 'associate' } });
    const commit = await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: { action: 'associate', token: 't'.repeat(32), challenge: 'challenge', note: 'valid note', mediaIndex: 0, targetIndices: [0] } });
    expect(prepare.statusCode).toBe(403);
    expect(commit.statusCode).toBe(403);
    expect(readCounts).toEqual(before);
    expect(state.listAssociationCache()).toEqual([]);
    expect(state.listManualReview(false)).toHaveLength(1);
  });

  it('prepares sanitized exact association evidence, rejects wrong bindings and changed queue/library/settings, then commits once', async () => {
    const { app, state, setQueue, setSnapshot, setSettings, getSettings, readCounts } = await apiFixture();
    const reviewId = await seedAssociation(state);
    const preparedReply = await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/prepare`, payload: { action: 'associate' } });
    expect(preparedReply.statusCode).toBe(200);
    const prepared = preparedReply.json();
    expect(prepared).toMatchObject({ targetNames: ['Show — Season 1'], queuePreview: { title: 'Show.S01E01', status: 'downloading' }, mediaChoices: [{ mediaIndex: 0, title: 'Show' }], targetChoices: [{ targetIndex: 0, workKey: 'sonarr:4:s1' }] });
    expect(preparedReply.body).not.toContain('job-1');
    expect(preparedReply.body).not.toContain('apikey');
    setQueue([{ ...associationQueue()[0]!, title: 'Show.S01E01 /mnt/private/secret.mkv http://arr.test/api?apikey=credential 0123456789abcdef0123456789abcdef01234567' }]);
    const privateQueue = await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/prepare`, payload: { action: 'associate' } });
    expect(privateQueue.body).not.toContain('private/secret');
    expect(privateQueue.body).not.toContain('arr.test');
    expect(privateQueue.body).not.toContain('credential');
    expect(privateQueue.body).not.toContain('0123456789abcdef');
    setQueue(associationQueue());
    const base = { action: 'associate', token: prepared.token, challenge: prepared.challenge, note: 'Reviewed current queue evidence', mediaIndex: 0, targetIndices: [0], workKey: 'sonarr:4:s1' };
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: { ...base, extraEvidence: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId + 10}/commit`, payload: base })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: { action: 'release', token: prepared.token, challenge: prepared.challenge, note: base.note, clientInspectionConfirmed: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: { ...base, challenge: 'wrong challenge' } })).statusCode).toBe(409);
    setQueue([{ ...associationQueue()[0]!, title: 'Changed.Show.S01E01' }]);
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: base })).statusCode).toBe(409);
    setQueue(associationQueue());
    const changedLibrary = librarySnapshot([episode(101, 1)]);
    changedLibrary.sonarr.series[0]!.episodes![0]!.title = 'Changed episode evidence';
    setSnapshot(changedLibrary);
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: base })).statusCode).toBe(409);
    setSnapshot(librarySnapshot([episode(101, 1)]));
    const allowed = getSettings();
    setSettings({ ...allowed, safety: { ...allowed.safety, allowOperatorActions: false } });
    const readsBeforeDisabledCommit = { ...readCounts };
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: base })).statusCode).toBe(403);
    expect(readCounts).toEqual(readsBeforeDisabledCommit);
    setSettings(allowed);
    const committed = await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: base });
    expect(committed.statusCode).toBe(200);
    expect(state.listAssociationCache()[0]?.decisions[0]).toMatchObject({ outcome: 'matched', potentialScope: 'series', workReferences: [{ workKey: 'sonarr:4:s1' }] });
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: base })).statusCode).toBe(409); // single use
  });

  it('releases an eligible multi-work reservation only after inspection and fresh evidence; failed commits preserve it and the proof', async () => {
    const snapshot = librarySnapshot([episode(101, 1), episode(201, 2)]);
    const { app, state, setQueue, readCounts, clock } = await apiFixture({ initialQueue: [], snapshot, clock: { value: ACTION_AT } });
    const { reviewId, intentId } = await seedMultiWorkRelease(state);
    const preparedReply = await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/prepare`, payload: { action: 'release' } });
    expect(preparedReply.statusCode).toBe(200);
    const prepared = preparedReply.json();
    expect(prepared).toMatchObject({ requiresClientInspection: true, queuePreview: null, targetNames: ['Show — Season 1', 'Show — Season 2'] });
    expect(prepared.challenge).toBe(RELEASE_ACK);
    const base = { action: 'release', token: prepared.token, challenge: prepared.challenge, note: 'Reviewed all relevant clients', clientInspectionConfirmed: true };
    const readsAfterPrepare = { ...readCounts };
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: { ...base, clientInspectionConfirmed: false } })).statusCode).toBe(400);
    expect(readCounts).toEqual(readsAfterPrepare);
    expect(state.listGrabIntents().find(({ id }) => id === intentId)?.releasedAt).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: { ...base, challenge: 'wrong' } })).statusCode).toBe(409);
    expect(state.listGrabIntents().find(({ id }) => id === intentId)?.releasedAt).toBeUndefined();
    const active: SonarrQueueRecord = { id: 91, downloadId: 'active-match', title: 'Show.S01E01', status: 'downloading', trackedDownloadStatus: null, trackedDownloadState: 'downloading', seriesId: 4, episodeId: 101, seasonNumber: 1 } as SonarrQueueRecord;
    setQueue([active]);
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: base })).statusCode).toBe(409);
    expect(state.listGrabIntents().find(({ id }) => id === intentId)?.releasedAt).toBeUndefined();
    setQueue([]);
    const released = await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: base });
    expect(released.statusCode).toBe(200);
    expect(state.listGrabIntents().find(({ id }) => id === intentId)?.releasedAt).toBe(ACTION_AT);
    expect(state.listManualReview(false)).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: base })).statusCode).toBe(409);
    expect(clock.value).toBe(ACTION_AT);
  });

  it('rejects an expired proof without releasing the reservation or consuming it', async () => {
    const { app, state, clock } = await apiFixture({ initialQueue: [], snapshot: librarySnapshot([episode(101, 1), episode(201, 2)]), clock: { value: ACTION_AT } });
    const { reviewId, intentId } = await seedMultiWorkRelease(state);
    const prepared = (await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/prepare`, payload: { action: 'release' } })).json();
    clock.value = new Date(Date.parse(prepared.expiresAt) + 1).toISOString();
    const result = await app.inject({ method: 'POST', url: `/api/operations/reviews/${reviewId}/commit`, payload: { action: 'release', token: prepared.token, challenge: prepared.challenge, note: 'Expired proof', clientInspectionConfirmed: true } });
    expect(result.statusCode).toBe(409);
    expect(state.listGrabIntents().find(({ id }) => id === intentId)?.releasedAt).toBeUndefined();
  });
});
