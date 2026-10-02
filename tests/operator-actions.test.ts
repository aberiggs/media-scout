import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { OperatorActions } from '../src/core/operator-actions';
import { State } from '../src/core/state';
import type { WorkItem } from '../src/core/work-queue-types';
import type { Config } from '../src/config';
import type { LibrarySnapshot } from '../src/core/watcher';

const NOW = '2026-01-01T00:00:00.000Z';
const DEADLINE = '2026-01-01T00:30:00.000Z';
const REVIEW_TIME = '2026-01-01T00:31:00.000Z';
const ACK = 'I inspected the download client(s), including routing used at submission; no matching download is active, and I authorize releasing this reservation so retries may become eligible.';

const work: WorkItem = {
  workKey: 'radarr:1', contentIdentity: 'radarr:1:tmdb:2:movie', missingFingerprint: 'movie-fingerprint',
  unit: { key: 'radarr:1', kind: 'movie', arr: 'radarr', serviceId: 1, externalId: 2, title: 'Movie', year: 2020, altTitles: [] },
  status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null,
  lastObservedAt: NOW, lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null,
};

function config(enabled: boolean): Config {
  return {
    PROWLARR_URL: 'http://prowlarr.test', PROWLARR_API_KEY: 'p-key', SONARR_URL: 'http://sonarr.test', SONARR_API_KEY: 's-key',
    RADARR_URL: 'http://radarr.test', RADARR_API_KEY: 'r-key', PROWLARR_CLIENT_TV: 'tv', PROWLARR_CLIENT_MOVIE: 'movie',
    LLM_BASE_URL: 'http://llm.test', LLM_API_KEY: 'llm-key', LLM_MODEL: 'model', MEDIA_PREFERENCES: '', CYCLE_INTERVAL_MIN: 5,
    MIN_RETRY_HOURS: 6, FAILURE_BACKOFF_MIN: 5, FAILURE_BACKOFF_MAX_MIN: 60, QUEUE_GRACE_MIN: 30, DRY_RUN: true,
    ALLOW_OPERATOR_ACTIONS: enabled, DB_PATH: ':memory:', HTTP_PORT: 7877, LOG_LEVEL: 'info',
  };
}

function setup(queueReads: Array<unknown[]> = [[], [], []]) {
  const state = new State(new Database(':memory:'));
  const owner = state.claimUnit(work.workKey, new Date(NOW))!;
  state.applyWorkReconciliation({ key: work.workKey, token: owner, work, intentUpdates: [] });
  const grabbed = state.beginGrab({ key: work.workKey, token: owner, fingerprint: work.missingFingerprint, release: { arr: 'radarr', indexerId: 3, guid: 'release-guid', infoHash: null, releaseTitle: 'Movie.2020' }, coverage: [{ workKey: work.workKey, episodeIds: null, basis: null }], now: NOW, deadline: DEADLINE });
  if (!grabbed.ok) throw new Error(grabbed.reason);
  state.markGrabUncertain({ intentId: grabbed.intentId, ownerToken: owner, now: DEADLINE });
  state.releaseClaim(work.workKey, owner);
  state.flagManualReviewLinked({ workKey: work.workKey, reason: 'queue-review', intentId: grabbed.intentId, at: new Date(REVIEW_TIME) });
  const snapshot: LibrarySnapshot = {
    observedAt: REVIEW_TIME,
    sonarr: { known: true, series: [] },
    radarr: { known: true, movies: [{ id: 1, tmdbId: 2, title: 'Movie', titleSlug: 'movie', year: 2020, monitored: true, hasFile: false, isAvailable: true, sizeOnDisk: 0 }] },
  };
  let queueIndex = 0;
  const watcher = { getSnapshot: vi.fn(async () => snapshot) };
  const sonarr = { getQueue: vi.fn(async () => []) };
  const radarr = { getQueue: vi.fn(async () => queueReads[Math.min(queueIndex++, queueReads.length - 1)] ?? []) };
  const service = new OperatorActions({ enabled: true, config: config(true), state, watcher: watcher as never, sonarr: sonarr as never, radarr: radarr as never, now: () => new Date(REVIEW_TIME) });
  return { service, state, watcher, sonarr, radarr, reviewId: state.listManualReview()[0]!.id };
}

describe('isolated operator action service', () => {
  it('rejects disabled actions before any review lookup or external read', async () => {
    const watcher = { getSnapshot: vi.fn(async () => { throw new Error('must not read'); }) };
    const service = new OperatorActions({ enabled: false, config: config(false), state: { listManualReview: vi.fn(() => []) } as never, watcher: watcher as never, sonarr: {} as never, radarr: {} as never });
    await expect(service.prepareReviewAction({ reviewId: 1, operation: 'release_intent_hold' })).rejects.toThrow(/disabled/);
    expect(watcher.getSnapshot).not.toHaveBeenCalled();
  });

  it('re-reads the queue before commit, rejects a newly active job without consuming the token, then allows fresh retry', async () => {
    const activeRow = { id: 7, downloadId: 'new-active-job', movieId: 1, title: 'Movie.2020', status: 'downloading', trackedDownloadStatus: null, trackedDownloadState: 'downloading' };
    const { service, state, radarr, reviewId } = setup([[], [activeRow], []]);
    const prepared = await service.prepareReviewAction({ reviewId, operation: 'release_intent_hold' });
    expect(prepared.challenge).toBe(ACK);
    await expect(service.releaseIntentHold({ reviewId, token: prepared.token, challengeResponse: ACK, note: 'Inspected matching client jobs' })).rejects.toThrow(/changed since prepare/);
    expect(state.listGrabIntents()[0]?.releasedAt).toBeUndefined();
    expect(radarr.getQueue).toHaveBeenCalledTimes(2);
    await expect(service.releaseIntentHold({ reviewId, token: prepared.token, challengeResponse: ACK, note: 'Inspected matching client jobs' })).resolves.toEqual({ released: true });
    expect(state.listGrabIntents()[0]?.status).toBe('uncertain');
    expect(state.listGrabIntents()[0]?.releasedAt).toBe(REVIEW_TIME);
    expect(radarr.getQueue).toHaveBeenCalledTimes(3);
  });

  it('prepares an index-bounded human association and re-reads material before its audited commit', async () => {
    const state = new State(new Database(':memory:'));
    const tvWork: WorkItem = {
      workKey: 'sonarr:4:s1', contentIdentity: 'sonarr:4:44:tv', missingFingerprint: 'episode-fingerprint',
      unit: { key: 'sonarr:4:s1', kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [], seriesType: 'standard', season: { seasonNumber: 1, missing: [{ episodeId: 10, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot' }] } },
      status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null,
      lastObservedAt: NOW, lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null,
    };
    const owner = state.claimUnit(tvWork.workKey, new Date(NOW))!;
    state.applyWorkReconciliation({ key: tvWork.workKey, token: owner, work: tvWork, intentUpdates: [] });
    state.releaseClaim(tvWork.workKey, owner);
    state.flagManualReview(tvWork.workKey, 'queue-review', undefined, new Date(REVIEW_TIME));
    const reviewId = state.listManualReview()[0]!.id;
    const snapshot: LibrarySnapshot = {
      observedAt: REVIEW_TIME,
      sonarr: { known: true, series: [{ series: { id: 4, tvdbId: 44, title: 'Show', titleSlug: 'show', seriesType: 'standard', monitored: true, seasons: [{ seasonNumber: 1, monitored: true, statistics: null }], alternateTitles: [] }, known: true, episodes: [{ id: 10, seriesId: 4, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot', airDate: '2020-01-01', monitored: true, hasFile: false }] }] },
      radarr: { known: true, movies: [] },
    };
    const queue = [{ id: 22, downloadId: 'job-1', title: 'Show.S01E01', status: 'downloading', trackedDownloadStatus: null, trackedDownloadState: 'downloading', seriesId: null, episodeId: null, seasonNumber: null }];
    let activeQueue = queue;
    const service = new OperatorActions({ enabled: true, config: config(true), state, watcher: { getSnapshot: async () => snapshot } as never, sonarr: { getQueue: async () => activeQueue } as never, radarr: { getQueue: async () => [] } as never, now: () => new Date(REVIEW_TIME) });
    const prepared = await service.prepareReviewAction({ reviewId, operation: 'associate_queue' });
    expect(prepared.queuePreview).toEqual({ title: 'Show.S01E01', status: 'downloading' });
    expect(prepared.associationChoices?.media).toEqual([{ index: 0, title: 'Show' }]);
    expect(prepared.associationChoices?.targets).toEqual([{ index: 0, title: 'Show' }]);
    await expect(service.associateQueue({ reviewId, token: prepared.token, proposedAssociation: { mediaIndex: 1, targetIndices: [0] }, challengeResponse: prepared.challenge, note: 'wrong index' })).rejects.toThrow(/proposed association indices/);
    activeQueue = [{ ...queue[0]!, title: 'Changed.Show.S01E01' }];
    await expect(service.associateQueue({ reviewId, token: prepared.token, proposedAssociation: { mediaIndex: 0, targetIndices: [0] }, challengeResponse: prepared.challenge, note: 'stale material' })).rejects.toThrow(/material changed/);
    activeQueue = queue;
    await expect(service.associateQueue({ reviewId, token: prepared.token, proposedAssociation: { mediaIndex: 0, targetIndices: [0] }, challengeResponse: prepared.challenge, note: 'Human matched supplied queue title' })).resolves.toEqual({ associated: true });
    expect(state.listAssociationCache()[0]?.decisions[0]).toMatchObject({ outcome: 'matched', potentialScope: 'series', workReferences: [{ workKey: tvWork.workKey }] });
  });
});
