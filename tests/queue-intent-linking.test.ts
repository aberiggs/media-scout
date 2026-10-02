import { describe, expect, it } from 'vitest';
import { reconcileWork } from '../src/core/work-queue';
import type { GrabIntent, IntentCoverage, QueueRead, WorkItem } from '../src/core/work-queue-types';
import type { LibrarySnapshot } from '../src/core/watcher';
import type { SonarrQueueRecord, Episode, Series } from '../src/types/sonarr';
import type { Movie, RadarrQueueRecord } from '../src/types/radarr';
import type { AssociationDecision } from '../src/core/group-types';

const OBSERVED = '2026-10-01T12:00:00.000Z';
const AFTER_GRACE = '2026-10-01T12:31:00.000Z';

const series: Series = {
  id: 22, tvdbId: 220, title: 'Inferred Pack Show', titleSlug: 'inferred-pack-show', seriesType: 'standard',
  monitored: true, seasons: [], alternateTitles: [],
};

function episode(id: number, seasonNumber = 1, hasFile = false): Episode {
  return {
    id, seriesId: series.id, seasonNumber, episodeNumber: id % 100, absoluteEpisodeNumber: null,
    title: `Episode ${id}`, airDate: '2020-01-01', monitored: true, hasFile,
  };
}

function inventory(episodes: Episode[] = Array.from({ length: 6 }, (_, index) => episode(2201 + index)), observedAt = OBSERVED): LibrarySnapshot {
  return {
    observedAt,
    sonarr: { known: true, series: [{ series, known: true, episodes }] },
    radarr: { known: true, movies: [] },
  };
}

const sonarrQueue = (records: SonarrQueueRecord[] = [], observedAt = OBSERVED): QueueRead<SonarrQueueRecord> => ({ kind: 'known', records, observedAt });
const radarrQueue = (records: RadarrQueueRecord[] = [], observedAt = OBSERVED): QueueRead<RadarrQueueRecord> => ({ kind: 'known', records, observedAt });

function directEpisodeRows(ids: number[], downloadId = 'sonarr-pack-22', seasonById?: ReadonlyMap<number, number>) {
  return ids.map((episodeId) => ({
    downloadId, seriesId: series.id, episodeId, seasonNumber: seasonById?.get(episodeId) ?? Math.floor(episodeId / 100) - 21,
    status: 'queued', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading',
  } as SonarrQueueRecord));
}

function coverageFor(episodes: Episode[], basis: IntentCoverage['basis'] = 'inferred-season-pack'): IntentCoverage[] {
  const seasons = new Map<number, number[]>();
  for (const item of episodes) seasons.set(item.seasonNumber, [...(seasons.get(item.seasonNumber) ?? []), item.id]);
  return [...seasons].map(([seasonNumber, episodeIds]) => ({
    workKey: `sonarr:${series.id}:s${seasonNumber}`, episodeIds, basis,
  }));
}

function intent(overrides: Partial<GrabIntent> = {}, capturedEpisodes = inventory().sonarr.series[0]!.episodes!): GrabIntent {
  return {
    id: 'pack-intent', ownerToken: 'owner', arr: 'sonarr', indexerId: 11, guid: 'release-guid', infoHash: null,
    releaseTitle: 'Inferred Pack Show S01', coverage: coverageFor(capturedEpisodes), status: 'awaiting-queue',
    startedAt: OBSERVED, confirmedAt: OBSERVED, queueDeadlineAt: '2026-10-01T12:30:00.000Z',
    lastSeenAt: null, queueRefs: [], ...overrides,
  };
}

function baseline(episodes = inventory().sonarr.series[0]!.episodes!): WorkItem[] {
  const snapshot = inventory(episodes);
  return reconcileWork({
    snapshot, queues: { sonarr: sonarrQueue(), radarr: radarrQueue() }, existingWorkItems: [], intents: [],
    now: OBSERVED, minRetryHours: 6, queueGraceMin: 30,
  }).items.map((item) => item.work);
}

function reconcile(input: {
  episodes?: Episode[];
  sonarr?: QueueRead<SonarrQueueRecord>;
  radarr?: QueueRead<RadarrQueueRecord>;
  intents?: GrabIntent[];
  workItems?: WorkItem[];
  manualReviewKeys?: ReadonlySet<string>;
  associationDecisions?: AssociationDecision[];
  now?: string;
  snapshotAt?: string;
}) {
  const episodes = input.episodes ?? inventory().sonarr.series[0]!.episodes!;
  return reconcileWork({
    snapshot: inventory(episodes, input.snapshotAt), queues: { sonarr: input.sonarr ?? sonarrQueue(), radarr: input.radarr ?? radarrQueue() },
    existingWorkItems: input.workItems ?? baseline(episodes), intents: input.intents ?? [],
    now: input.now ?? OBSERVED, minRetryHours: 6, queueGraceMin: 30, manualReviewKeys: input.manualReviewKeys,
    associationDecisions: input.associationDecisions,
  });
}

describe('confirmed queue intent linking', () => {
  it('links six direct episode rows as one healthy physical job and records its stable ref', () => {
    const episodes = inventory().sonarr.series[0]!.episodes!;
    const result = reconcile({ sonarr: sonarrQueue(directEpisodeRows(episodes.map((item) => item.id))), intents: [intent()] });

    expect(result.intentUpdates).toContainEqual({
      id: 'pack-intent', status: 'active', lastSeenAt: OBSERVED, queueRefs: ['download:sonarr-pack-22'],
    });
    expect(result.items.every((item) => item.eligibleUnit === null)).toBe(true);
    expect(result.intentUpdates).not.toContainEqual(expect.objectContaining({ status: 'uncertain' }));
  });

  it('keeps a healthy confirmed intent active after its appearance grace deadline', () => {
    const episodes = inventory().sonarr.series[0]!.episodes!;
    const result = reconcile({
      sonarr: sonarrQueue(directEpisodeRows(episodes.map((item) => item.id)), AFTER_GRACE), intents: [intent()], now: AFTER_GRACE, snapshotAt: AFTER_GRACE,
    });

    expect(result.intentUpdates).toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: ['download:sonarr-pack-22'] }));
    expect(result.items.some((item) => item.manualReviewReason === 'queue-review')).toBe(false);
  });

  it('keeps an unhealthy raw row in the physical-job link veto despite an unrelated cached decision', () => {
    const episodes = inventory().sonarr.series[0]!.episodes!;
    const rawRows = [
      ...directEpisodeRows(episodes.map((item) => item.id)),
      { downloadId: 'sonarr-pack-22', title: 'Unidentified row', status: 'downloading', trackedDownloadStatus: 'warning', trackedDownloadState: 'downloading' } as SonarrQueueRecord,
    ];
    const cachedUnrelated: AssociationDecision = {
      arr: 'sonarr', queueRef: 'download:sonarr-pack-22', outcome: 'unrelated', mediaReferences: [], workReferences: [],
      potentialScope: 'unknown', seasonNumber: null, episodeIds: null, basis: null, uncertainty: null,
    };
    const result = reconcile({ sonarr: sonarrQueue(rawRows), intents: [intent()], associationDecisions: [cachedUnrelated] });

    expect(result.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: ['download:sonarr-pack-22'] }));
  });

  it('does not link partial direct coverage, an unconfirmed intent, or inferred/parser-only targets', () => {
    const episodes = inventory().sonarr.series[0]!.episodes!;
    const partial = reconcile({ sonarr: sonarrQueue(directEpisodeRows(episodes.slice(0, 5).map((item) => item.id))), intents: [intent()] });
    expect(partial.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: expect.any(Array) }));

    const uncertain = reconcile({
      sonarr: sonarrQueue(directEpisodeRows(episodes.map((item) => item.id))),
      intents: [intent({ confirmedAt: null, status: 'submitting' })],
    });
    expect(uncertain.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: expect.any(Array) }));

    const inferredOnlyRows = episodes.map(() => ({
      downloadId: 'sonarr-pack-22', seriesId: series.id, seasonNumber: 1, status: 'queued',
      trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading',
    } as SonarrQueueRecord));
    const inferredOnly = reconcile({ sonarr: sonarrQueue(inferredOnlyRows), intents: [intent()] });
    expect(inferredOnly.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: expect.any(Array) }));
  });

  it('does not link when the physical job is ambiguous, unhealthy, conflicting, or has no usable download id', () => {
    const episodes = inventory().sonarr.series[0]!.episodes!;
    const ids = episodes.map((item) => item.id);
    const twoJobs = [...directEpisodeRows(ids.slice(0, 3), 'job-a'), ...directEpisodeRows(ids.slice(3), 'job-b')];
    const competing = reconcile({ sonarr: sonarrQueue(twoJobs), intents: [intent()] });
    expect(competing.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: expect.any(Array) }));

    const mixedHealth = directEpisodeRows(ids);
    mixedHealth[4] = { ...mixedHealth[4]!, trackedDownloadStatus: 'warning' };
    const unhealthy = reconcile({ sonarr: sonarrQueue(mixedHealth), intents: [intent()] });
    expect(unhealthy.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: expect.any(Array) }));

    const conflicting = directEpisodeRows(ids);
    conflicting[5] = { ...conflicting[5]!, seriesId: 999 };
    const conflict = reconcile({ sonarr: sonarrQueue(conflicting), intents: [intent()] });
    expect(conflict.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: expect.any(Array) }));

    const blankId = directEpisodeRows(ids).map((row) => ({ ...row, downloadId: '   ' }));
    const noPhysicalRef = reconcile({ sonarr: sonarrQueue(blankId), intents: [intent()] });
    expect(noPhysicalRef.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: expect.any(Array) }));

    const missingHealth = directEpisodeRows(ids).map((row) => ({ ...row, trackedDownloadStatus: null, trackedDownloadState: null }));
    const notPositivelyHealthy = reconcile({ sonarr: sonarrQueue(missingHealth), intents: [intent()] });
    expect(notPositivelyHealthy.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: expect.any(Array) }));
  });

  it('keeps queue references isolated by Arr and prevents two open intents from claiming one job', () => {
    const episodes = inventory().sonarr.series[0]!.episodes!;
    const sonarrRows = directEpisodeRows(episodes.map((item) => item.id));
    const radarrCollision = [{ downloadId: 'sonarr-pack-22', movieId: 55, status: 'queued', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading' } as RadarrQueueRecord];
    const isolated = reconcile({ sonarr: sonarrQueue(sonarrRows), radarr: radarrQueue(radarrCollision), intents: [intent()] });
    expect(isolated.intentUpdates).toContainEqual(expect.objectContaining({ id: 'pack-intent', queueRefs: ['download:sonarr-pack-22'] }));

    const second = intent({ id: 'second-intent', queueRefs: [] });
    const competing = reconcile({ sonarr: sonarrQueue(sonarrRows), intents: [intent(), second] });
    expect(competing.intentUpdates).not.toContainEqual(expect.objectContaining({ status: 'active', queueRefs: ['download:sonarr-pack-22'] }));
  });

  it('links a healthy Radarr movie only from its direct movie id', () => {
    const movie: Movie = {
      id: 55, tmdbId: 555, title: 'Movie', titleSlug: 'movie', year: 2020, monitored: true, hasFile: false,
      isAvailable: true, sizeOnDisk: 0,
    };
    const movieIntent = intent({
      id: 'movie-intent', arr: 'radarr', coverage: [{ workKey: 'radarr:55', episodeIds: null, basis: null }],
    });
    const result = reconcileWork({
      snapshot: { observedAt: OBSERVED, sonarr: { known: true, series: [] }, radarr: { known: true, movies: [movie] } },
      queues: {
        sonarr: sonarrQueue(),
        radarr: radarrQueue([{ downloadId: 'movie-download', movieId: 55, status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading' }]),
      },
      existingWorkItems: [], intents: [movieIntent], now: OBSERVED, minRetryHours: 6, queueGraceMin: 30,
    });

    expect(result.intentUpdates).toContainEqual({
      id: 'movie-intent', status: 'active', lastSeenAt: OBSERVED, queueRefs: ['download:movie-download'],
    });
  });

  it('does not refresh intent links or last-seen timestamps from unknown, stale, or future observations', () => {
    const episodes = inventory().sonarr.series[0]!.episodes!;
    const linked = intent({ status: 'active', queueRefs: ['download:sonarr-pack-22'], lastSeenAt: OBSERVED });
    const unknown = reconcile({
      sonarr: { kind: 'unknown', observedAt: '2026-10-01T12:05:00.000Z', errorCode: 'queue-read-failed' }, intents: [linked],
      now: '2026-10-01T12:05:00.000Z',
    });
    expect(unknown.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', lastSeenAt: expect.any(String) }));

    const stale = reconcile({
      sonarr: sonarrQueue(directEpisodeRows(episodes.map((item) => item.id)), '2026-10-01T11:59:00.000Z'), intents: [intent()],
      now: '2026-10-01T12:05:00.000Z',
    });
    expect(stale.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: expect.any(Array) }));

    const future = reconcile({
      sonarr: sonarrQueue(directEpisodeRows(episodes.map((item) => item.id)), '2026-10-01T12:06:00.000Z'), intents: [intent()],
      now: '2026-10-01T12:05:00.000Z',
    });
    expect(future.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', lastSeenAt: expect.any(String) }));

    const intentSeenAfterQueue = reconcile({
      sonarr: sonarrQueue(directEpisodeRows(episodes.map((item) => item.id)), OBSERVED), intents: [intent({ ...linked, lastSeenAt: '2026-10-01T12:05:00.000Z' })],
      now: '2026-10-01T12:05:00.000Z',
    });
    expect(intentSeenAfterQueue.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', lastSeenAt: expect.any(String) }));
  });

  it('reviews disappeared, failed, or import-blocked linked jobs without releasing captured holds', () => {
    const episodes = inventory().sonarr.series[0]!.episodes!;
    const linked = intent({ status: 'active', queueRefs: ['download:sonarr-pack-22'] });
    const pending = reconcile({ intents: [intent()], now: OBSERVED });
    expect(pending.intentUpdates).toEqual([]);
    expect(pending.items.some((item) => item.manualReviewReason === 'queue-review')).toBe(false);
    const replacementJob = sonarrQueue(directEpisodeRows(episodes.map((item) => item.id), 'replacement-job'), AFTER_GRACE);
    const emptyAfterGrace = reconcile({ sonarr: replacementJob, intents: [linked], now: AFTER_GRACE, snapshotAt: AFTER_GRACE });
    expect(emptyAfterGrace.intentUpdates).not.toContainEqual(expect.objectContaining({ queueRefs: ['download:replacement-job'] }));
    expect(emptyAfterGrace.items.some((item) => item.manualReviewReason === 'queue-review' && item.eligibleUnit === null)).toBe(true);

    const failedRows = directEpisodeRows(episodes.map((item) => item.id)).map((row) => ({ ...row, status: 'failed' }));
    const failed = reconcile({ sonarr: sonarrQueue(failedRows, AFTER_GRACE), intents: [linked], now: AFTER_GRACE, snapshotAt: AFTER_GRACE });
    expect(failed.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'failed' }));
    expect(failed.items.some((item) => item.manualReviewReason === 'queue-review' && item.eligibleUnit === null)).toBe(true);
    expect(failed.items.every((item) => item.activeCoverage.some((coverage) => coverage.workKey.startsWith('sonarr:22:s')))).toBe(true);

    const blockedRows = directEpisodeRows(episodes.map((item) => item.id)).map((row) => ({ ...row, trackedDownloadState: 'importBlocked' }));
    const blocked = reconcile({ sonarr: sonarrQueue(blockedRows, AFTER_GRACE), intents: [linked], now: AFTER_GRACE, snapshotAt: AFTER_GRACE });
    expect(blocked.intentUpdates).toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'import-blocked' }));
    expect(blocked.items.some((item) => item.manualReviewReason === 'queue-review' && item.eligibleUnit === null)).toBe(true);

    const reviewWork = baseline(episodes).map((work) => ({ ...work, status: 'manual' as const, blockedReason: 'queue-review' }));
    const notAutoResolved = reconcile({
      sonarr: sonarrQueue(directEpisodeRows(episodes.map((item) => item.id))), intents: [linked], workItems: reviewWork,
      manualReviewKeys: new Set(reviewWork.map((work) => work.workKey)),
    });
    expect(notAutoResolved.items.every((item) => item.work.status === 'manual' && item.work.blockedReason === 'queue-review')).toBe(true);
  });

  it('links complete multi-season direct coverage independently of row and season order', () => {
    const episodes = [episode(2201, 1), episode(2202, 1), episode(2203, 2), episode(2204, 2)];
    const seasonById = new Map(episodes.map((item) => [item.id, item.seasonNumber]));
    const rows = [
      ...directEpisodeRows([2201, 2202], 'multi-season-job', seasonById),
      ...directEpisodeRows([2203, 2204], 'multi-season-job', seasonById),
    ];
    const forward = reconcile({ episodes, sonarr: sonarrQueue(rows), intents: [intent({}, episodes)] });
    const reverse = reconcile({ episodes: [...episodes].reverse(), sonarr: sonarrQueue([...rows].reverse()), intents: [intent({}, episodes)] });
    const expected = { id: 'pack-intent', status: 'active', lastSeenAt: OBSERVED, queueRefs: ['download:multi-season-job'] };
    expect(forward.intentUpdates).toContainEqual(expected);
    expect(reverse.intentUpdates).toContainEqual(expected);
  });

  it('ignores authoritative disjoint jobs as competitors but keeps overlapping jobs ambiguous', () => {
    const episodes = [episode(2201, 1), episode(2202, 1), episode(2203, 2), episode(2204, 2)];
    const seasonById = new Map(episodes.map((item) => [item.id, item.seasonNumber]));
    const disjointSeasonJobs = sonarrQueue([
      ...directEpisodeRows([2201, 2202], 'season-one-job', seasonById),
      ...directEpisodeRows([2203, 2204], 'season-two-job', seasonById),
    ]);
    const seasonOne = intent({}, episodes.slice(0, 2));
    const firstSeasonOnly = reconcile({ episodes, sonarr: disjointSeasonJobs, intents: [seasonOne] });
    expect(firstSeasonOnly.intentUpdates).toContainEqual(expect.objectContaining({ id: 'pack-intent', queueRefs: ['download:season-one-job'] }));

    const seasonTwo = intent({ id: 'season-two-intent' }, episodes.slice(2));
    const bothSeasons = reconcile({ episodes, sonarr: disjointSeasonJobs, intents: [seasonOne, seasonTwo] });
    expect(bothSeasons.intentUpdates).toContainEqual(expect.objectContaining({ id: 'pack-intent', queueRefs: ['download:season-one-job'] }));
    expect(bothSeasons.intentUpdates).toContainEqual(expect.objectContaining({ id: 'season-two-intent', queueRefs: ['download:season-two-job'] }));

    const overlappingJobs = sonarrQueue([
      ...directEpisodeRows([2201, 2202], 'complete-job', seasonById),
      ...directEpisodeRows([2202], 'overlap-job', seasonById),
    ]);
    const overlapping = reconcile({ episodes, sonarr: overlappingJobs, intents: [seasonOne] });
    expect(overlapping.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'active', queueRefs: expect.any(Array) }));

    const disjointSameSeason = sonarrQueue([
      ...directEpisodeRows([2201], 'episode-one-job', seasonById),
      ...directEpisodeRows([2202], 'episode-two-job', seasonById),
    ]);
    const episodeOne = intent({ id: 'episode-one-intent' }, [episodes[0]!]);
    const episodeTwo = intent({ id: 'episode-two-intent' }, [episodes[1]!]);
    const sameSeasonIntents = reconcile({ episodes, sonarr: disjointSameSeason, intents: [episodeOne, episodeTwo] });
    expect(sameSeasonIntents.intentUpdates).toContainEqual(expect.objectContaining({ id: 'episode-one-intent', queueRefs: ['download:episode-one-job'] }));
    expect(sameSeasonIntents.intentUpdates).toContainEqual(expect.objectContaining({ id: 'episode-two-intent', queueRefs: ['download:episode-two-job'] }));
  });

  it('fulfills only from positive library hasFile evidence, independently of queue appearance', () => {
    const episodes = inventory().sonarr.series[0]!.episodes!;
    const captured = intent({ status: 'active', queueRefs: ['download:sonarr-pack-22'] });
    const partialFiles = episodes.map((item, index) => ({ ...item, hasFile: index < 5 }));
    const partial = reconcile({ episodes: partialFiles, sonarr: sonarrQueue(), intents: [captured] });
    expect(partial.intentUpdates).not.toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'fulfilled' }));

    const allFiles = episodes.map((item) => ({ ...item, hasFile: true }));
    const complete = reconcile({ episodes: allFiles, sonarr: sonarrQueue(), intents: [captured], workItems: baseline(episodes) });
    expect(complete.intentUpdates).toContainEqual(expect.objectContaining({ id: 'pack-intent', status: 'fulfilled', lastSeenAt: expect.any(String) }));
  });
});
