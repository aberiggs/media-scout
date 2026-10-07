import { describe, expect, it } from 'vitest';
import { reconcileWork, candidateOverlapsQueue } from '../src/core/work-queue';
import type { LibrarySnapshot } from '../src/core/watcher';
import type { GrabIntent, WorkItem, QueueRead } from '../src/core/work-queue-types';
import type { Episode, Series, SonarrQueueRecord } from '../src/types/sonarr';
import type { Movie, RadarrQueueRecord } from '../src/types/radarr';
import type { AssociationDecision } from '../src/core/group-types';

const NOW = '2026-09-29T00:00:00.000Z';
const LATER = '2026-09-29T00:05:00.000Z';

const series = { id: 4, tvdbId: 44, title: 'Show', titleSlug: 'show', seriesType: 'standard', monitored: true, seasons: [], alternateTitles: [] } as Series;
const ep = (id: number, aired: boolean, hasFile = false): Episode => ({ id, seriesId: 4, seasonNumber: 1, episodeNumber: id - 100, absoluteEpisodeNumber: null, title: `E${id}`, airDate: aired ? '2020-01-01' : null, monitored: true, hasFile });
const movie = (overrides: Partial<Movie> = {}): Movie => ({ id: 8, tmdbId: 88, title: 'Movie', titleSlug: 'movie', year: 2020, monitored: true, hasFile: false, isAvailable: true, sizeOnDisk: 0, ...overrides });
const snapshot = (episodes: Episode[] = [ep(101, true), ep(102, false)], movies: Movie[] = []): LibrarySnapshot => ({
  observedAt: NOW,
  sonarr: { known: true, series: [{ series, known: true, episodes }] },
  radarr: { known: true, movies },
});
const knownTvQueue = (records: SonarrQueueRecord[] = [], observedAt = NOW): QueueRead<SonarrQueueRecord> => ({ kind: 'known', records, observedAt });
const knownMovieQueue = (records: RadarrQueueRecord[] = [], observedAt = NOW): QueueRead<RadarrQueueRecord> => ({ kind: 'known', records, observedAt });
const emptyIntents: GrabIntent[] = [];

function reconcile(input: {
  inventory?: LibrarySnapshot;
  tvQueue?: QueueRead<SonarrQueueRecord>;
  movieQueue?: QueueRead<RadarrQueueRecord>;
  workItems?: WorkItem[];
} = {}) {
  return reconcileWork({
    snapshot: input.inventory ?? snapshot(),
    queues: { sonarr: input.tvQueue ?? knownTvQueue(), radarr: input.movieQueue ?? knownMovieQueue() },
    existingWorkItems: input.workItems ?? [],
    intents: emptyIntents,
    now: NOW,
    minRetryHours: 6,
    queueGraceMin: 30,
  });
}

describe('reconcileWork', () => {
  it('consumes a reset marker only after a known library observation began after reset and re-enables rediscovery', () => {
    const resetAt = '2026-09-29T00:05:00.000Z';
    const prior = { ...reconcile().items.find((item) => item.work.workKey === 'sonarr:4:s1')!.work,
      status: 'backoff' as const, lastSearchAt: NOW, nextSearchAt: resetAt, resetPendingAt: resetAt };
    const evaluate = (inventory: LibrarySnapshot) => reconcileWork({
      snapshot: inventory, queues: { sonarr: knownTvQueue([], inventory.observedAt), radarr: knownMovieQueue([], inventory.observedAt) },
      existingWorkItems: [prior], intents: [], now: '2026-09-29T00:10:00.000Z', minRetryHours: 6, queueGraceMin: 30,
    }).items.find((item) => item.work.workKey === prior.workKey)!;

    expect(evaluate(snapshot()).work.resetPendingAt).toBe(resetAt); // observation predates reset
    const unknown = snapshot();
    unknown.observedAt = '2026-09-29T00:06:00.000Z';
    unknown.sonarr.known = false;
    unknown.sonarr.series = [];
    expect(evaluate(unknown).work.resetPendingAt).toBe(resetAt); // timestamp alone is not proof
    const after = snapshot();
    after.observedAt = '2026-09-29T00:06:00.000Z';
    const refreshed = evaluate(after);
    expect(refreshed.work.resetPendingAt).toBeNull();
    expect(refreshed.work.status).toBe('ready');
    expect(refreshed.eligibleUnit?.key).toBe(prior.workKey);
    expect(refreshed.work.lastSearchAt).toBe(NOW); // reconciliation itself does not issue a search
  });

  it('keeps all missing inventory while making only aired episodes eligible', () => {
    const result = reconcile();
    const row = result.items.find((item) => item.work.workKey === 'sonarr:4:s1');
    expect(row?.work.unit.season?.missing.map((item) => item.episodeId)).toEqual([101, 102]);
    expect(row?.eligibleUnit?.season?.missing.map((item) => item.episodeId)).toEqual([101]);
    expect(row?.work.status).toBe('ready');
  });

  it('turns known episode queue associations into scoped coverage and leaves partial residuals', () => {
    const result = reconcile({ tvQueue: knownTvQueue([{ downloadId: 'download-a', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'downloading' } as SonarrQueueRecord]) });
    const row = result.items.find((item) => item.work.workKey === 'sonarr:4:s1');
    expect(row?.activeCoverage).toEqual([{ workKey: 'sonarr:4:s1', episodeIds: [101], basis: 'explicit-episodes' }]);
    expect(row?.eligibleUnit).toBeNull(); // the only aired target is already queued
    expect(row?.blockedReason).toBe('queue-active');
  });

  it('holds the actual episode when a direct episode id contradicts queue series or season scope', () => {
    for (const record of [
      { downloadId: 'wrong-season', seriesId: 4, episodeId: 101, seasonNumber: 2, status: 'downloading' },
      { downloadId: 'wrong-series', seriesId: 999, episodeId: 101, seasonNumber: 1, status: 'downloading' },
    ] as SonarrQueueRecord[]) {
      const result = reconcile({ tvQueue: knownTvQueue([record]) });
      expect(result.items.find((item) => item.work.workKey === 'sonarr:4:s1')).toMatchObject({
        blockedReason: 'queue-ambiguous', eligibleUnit: null,
      });

      const captured: GrabIntent = {
        id: `conflicted-${record.downloadId}`, ownerToken: 'owner', arr: 'sonarr', indexerId: 4, guid: 'g',
        infoHash: null, releaseTitle: 'Release', coverage: [{ workKey: 'sonarr:4:s1', episodeIds: [101], basis: 'explicit-episodes' }],
        status: 'awaiting-queue', startedAt: NOW, confirmedAt: NOW, queueDeadlineAt: LATER, lastSeenAt: null, queueRefs: [],
      };
      const withIntent = reconcileWork({
        snapshot: snapshot(), queues: { sonarr: knownTvQueue([record]), radarr: knownMovieQueue() },
        existingWorkItems: [], intents: [captured], now: NOW, minRetryHours: 6, queueGraceMin: 30,
      });
      expect(withIntent.intentUpdates).not.toContainEqual(expect.objectContaining({ id: captured.id, status: 'active' }));
      expect(withIntent.items.find((item) => item.work.workKey === 'sonarr:4:s1')).toMatchObject({ eligibleUnit: null, blockedReason: 'queue-ambiguous' });
    }
  });

  it('blocks an Arr when its queue read is unknown rather than treating failure as empty', () => {
    const result = reconcile({ tvQueue: { kind: 'unknown', observedAt: NOW, errorCode: 'queue-read-failed' } });
    expect(result.items.find((item) => item.work.workKey === 'sonarr:4:s1')).toMatchObject({ eligibleUnit: null, blockedReason: 'queue-unknown' });
  });

  it('preserves the last successful queue timestamp when the current queue read fails', () => {
    const known = reconcile({ tvQueue: knownTvQueue([{ downloadId: 'known', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'downloading' } as SonarrQueueRecord]) });
    const saved = known.items.find((item) => item.work.workKey === 'sonarr:4:s1')!;
    expect(saved.work).toMatchObject({ lastQueueObservedAt: NOW, queueObservationKnown: true });
    const unknown = reconcileWork({
      snapshot: snapshot(), queues: { sonarr: { kind: 'unknown', observedAt: LATER, errorCode: 'queue-read-failed' }, radarr: knownMovieQueue() },
      existingWorkItems: [saved.work], intents: [], previousQueueCoverage: new Map([[saved.work.workKey, saved.queueCoverage]]),
      now: LATER, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(unknown.items[0]?.work).toMatchObject({ lastQueueObservedAt: NOW, queueObservationKnown: false, blockedReason: 'queue-unknown' });
  });

  it('treats a known but stale empty queue as unknown and preserves newer queue evidence', () => {
    const initial = reconcile({ tvQueue: knownTvQueue([{ downloadId: 'still-held', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'downloading' } as SonarrQueueRecord]) });
    const old = initial.items.find((item) => item.work.workKey === 'sonarr:4:s1')!;
    const laterSnapshot = { ...snapshot(), observedAt: LATER };
    const stale = reconcileWork({
      snapshot: laterSnapshot,
      queues: { sonarr: knownTvQueue([], NOW), radarr: knownMovieQueue() },
      existingWorkItems: [old.work], intents: [], previousQueueCoverage: new Map([[old.work.workKey, old.queueCoverage]]),
      now: LATER, minRetryHours: 6, queueGraceMin: 30,
    });

    expect(stale.items[0]).toMatchObject({
      work: { blockedReason: 'queue-unknown', lastQueueObservedAt: NOW, queueObservationKnown: false },
      queueCoverage: old.queueCoverage, activeCoverage: old.activeCoverage, eligibleUnit: null,
    });
    expect(stale.items[0]?.manualReviewReason).not.toBe('queue-review');
  });

  it('keeps terminal work queue freshness monotonic while allowing positive fulfillment and inactivity', () => {
    const saved = reconcile().items.find((item) => item.work.workKey === 'sonarr:4:s1')!.work;
    const previouslyObserved = { ...saved, lastObservedAt: LATER, lastQueueObservedAt: LATER, queueObservationKnown: true };
    const currentAt = '2026-09-29T00:31:00.000Z';
    const filled = snapshot([ep(101, true, true), ep(102, false, true)]);
    const capture: GrabIntent = {
      id: 'terminal-capture', ownerToken: 'owner', arr: 'sonarr', indexerId: 4, guid: 'g', infoHash: null,
      releaseTitle: 'Release', coverage: [{ workKey: saved.workKey, episodeIds: [101, 102], basis: 'explicit-episodes' }],
      status: 'active', startedAt: NOW, confirmedAt: NOW, queueDeadlineAt: LATER, lastSeenAt: LATER, queueRefs: ['download:old'],
    };
    const fulfilled = reconcileWork({
      snapshot: { ...filled, observedAt: currentAt }, queues: { sonarr: knownTvQueue([], NOW), radarr: knownMovieQueue() },
      existingWorkItems: [previouslyObserved], intents: [capture], now: currentAt, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(fulfilled.items[0]?.work).toMatchObject({
      status: 'fulfilled', lastQueueObservedAt: LATER, queueObservationKnown: false,
      unit: { season: { missing: [{ episodeId: 101 }, { episodeId: 102 }] } },
    });
    expect(fulfilled.intentUpdates).toContainEqual(expect.objectContaining({ id: capture.id, status: 'fulfilled' }));

    const nextKnownAt = '2026-09-29T00:32:00.000Z';
    const nextKnown = reconcileWork({
      snapshot: { ...filled, observedAt: nextKnownAt }, queues: { sonarr: knownTvQueue([], nextKnownAt), radarr: knownMovieQueue([], nextKnownAt) },
      existingWorkItems: [fulfilled.items[0]!.work], intents: [], now: nextKnownAt, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(nextKnown.items[0]?.work).toMatchObject({ status: 'fulfilled', unit: { season: { missing: [{ episodeId: 101 }, { episodeId: 102 }] } } });

    const unmonitored = snapshot([{ ...ep(101, true, true), monitored: false }, { ...ep(102, false, true), monitored: false }]);
    unmonitored.sonarr.series[0]!.series = { ...series, monitored: false };
    const unmonitoredComplete = reconcileWork({
      snapshot: { ...unmonitored, observedAt: currentAt }, queues: { sonarr: knownTvQueue([], currentAt), radarr: knownMovieQueue([], currentAt) },
      existingWorkItems: [previouslyObserved], intents: [], now: currentAt, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(unmonitoredComplete.items[0]?.work).toMatchObject({
      status: 'fulfilled', unit: { season: { missing: [{ episodeId: 101 }, { episodeId: 102 }] } },
    });
    const unmonitoredNextPoll = reconcileWork({
      snapshot: { ...unmonitored, observedAt: nextKnownAt }, queues: { sonarr: knownTvQueue([], nextKnownAt), radarr: knownMovieQueue([], nextKnownAt) },
      existingWorkItems: [unmonitoredComplete.items[0]!.work], intents: [], now: nextKnownAt, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(unmonitoredNextPoll.items[0]?.work.status).toBe('fulfilled');

    const incompleteUnmonitored = snapshot([{ ...ep(101, true, true), monitored: false }, { ...ep(102, false), monitored: false }]);
    incompleteUnmonitored.sonarr.series[0]!.series = { ...series, monitored: false };
    const inactive = reconcileWork({
      snapshot: { ...incompleteUnmonitored, observedAt: currentAt }, queues: { sonarr: knownTvQueue([], NOW), radarr: knownMovieQueue() },
      existingWorkItems: [previouslyObserved], intents: [], now: currentAt, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(inactive.items[0]?.work).toMatchObject({
      status: 'inactive', lastQueueObservedAt: LATER, queueObservationKnown: false,
      unit: { season: { missing: [{ episodeId: 101 }, { episodeId: 102 }] } },
    });
    const filesArrivedLater = snapshot([{ ...ep(101, true, true), monitored: false }, { ...ep(102, true, true), monitored: false }]);
    filesArrivedLater.sonarr.series[0]!.series = { ...series, monitored: false };
    const reclassified = reconcileWork({
      snapshot: { ...filesArrivedLater, observedAt: nextKnownAt }, queues: { sonarr: knownTvQueue([], nextKnownAt), radarr: knownMovieQueue([], nextKnownAt) },
      existingWorkItems: [inactive.items[0]!.work], intents: [], now: nextKnownAt, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(reclassified.items[0]?.work.status).toBe('fulfilled');

    const removedTarget = snapshot([{ ...ep(101, true, true), monitored: false }]);
    removedTarget.sonarr.series[0]!.series = { ...series, monitored: false };
    const removedNotComplete = reconcileWork({
      snapshot: { ...removedTarget, observedAt: currentAt }, queues: { sonarr: knownTvQueue([], currentAt), radarr: knownMovieQueue([], currentAt) },
      existingWorkItems: [previouslyObserved], intents: [], now: currentAt, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(removedNotComplete.items[0]?.work.status).toBe('inactive');

    const emptyTerminal = { ...previouslyObserved, status: 'inactive' as const, unit: { ...previouslyObserved.unit, season: { seasonNumber: 1, missing: [] } } };
    const emptyCannotComplete = reconcileWork({
      snapshot: { ...snapshot([ep(101, true), ep(102, true)]), observedAt: currentAt }, queues: { sonarr: knownTvQueue([], currentAt), radarr: knownMovieQueue([], currentAt) },
      existingWorkItems: [emptyTerminal], intents: [], now: currentAt, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(emptyCannotComplete.items[0]?.work.status).toBe('ready'); // actual missing targets reappear; empty history is not completion proof

    const previousMovie = reconcile({ inventory: snapshot([], [movie()]) }).items.find((item) => item.work.workKey === 'radarr:8')!.work;
    for (const monitored of [true, false]) {
      const completedMovie = snapshot([], [movie({ monitored, hasFile: true })]);
      const completed = reconcileWork({
        snapshot: { ...completedMovie, observedAt: currentAt }, queues: { sonarr: knownTvQueue([], currentAt), radarr: knownMovieQueue([], currentAt) },
        existingWorkItems: [previousMovie], intents: [], now: currentAt, minRetryHours: 6, queueGraceMin: 30,
      });
      const completedMovieWork = completed.items.find((item) => item.work.workKey === previousMovie.workKey)!.work;
      expect(completedMovieWork.status).toBe('fulfilled');
      const secondPollAt = '2026-09-29T00:32:00.000Z';
      const secondPoll = reconcileWork({
        snapshot: { ...completedMovie, observedAt: secondPollAt }, queues: { sonarr: knownTvQueue([], secondPollAt), radarr: knownMovieQueue([], secondPollAt) },
        existingWorkItems: [completedMovieWork], intents: [], now: secondPollAt, minRetryHours: 6, queueGraceMin: 30,
      });
      expect(secondPoll.items.find((item) => item.work.workKey === previousMovie.workKey)?.work.status).toBe('fulfilled');
    }
    const noMovieFile = snapshot([], [movie({ monitored: false, hasFile: false })]);
    const inactiveMovie = reconcileWork({
      snapshot: { ...noMovieFile, observedAt: currentAt }, queues: { sonarr: knownTvQueue([], currentAt), radarr: knownMovieQueue([], currentAt) },
      existingWorkItems: [previousMovie], intents: [], now: currentAt, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(inactiveMovie.items.find((item) => item.work.workKey === previousMovie.workKey)?.work.status).toBe('inactive');
  });

  it('rechecks legacy empty TV snapshots only against a nonempty complete same-season file inventory', () => {
    const previous = reconcile().items.find((item) => item.work.workKey === 'sonarr:4:s1')!.work;
    const legacyTerminal: WorkItem = {
      ...previous, status: 'inactive', missingFingerprint: JSON.stringify([previous.contentIdentity, []]),
      unit: { ...previous.unit, season: { seasonNumber: 1, missing: [] } },
    };
    const poll = (episodes: Episode[], options: { monitored?: boolean; known?: boolean } = {}, old = legacyTerminal) => {
      const inventory = snapshot(episodes);
      inventory.sonarr.series[0]!.series = { ...inventory.sonarr.series[0]!.series, monitored: options.monitored ?? true };
      if (options.known === false) {
        inventory.sonarr.series[0]!.known = false;
        inventory.sonarr.series[0]!.episodes = null;
      }
      return reconcileWork({
        snapshot: inventory, queues: { sonarr: knownTvQueue([], inventory.observedAt), radarr: knownMovieQueue([], inventory.observedAt) },
        existingWorkItems: [old], intents: [], now: inventory.observedAt, minRetryHours: 6, queueGraceMin: 30,
      });
    };
    for (const monitored of [true, false]) {
      const completeEpisodes = [ep(101, true, true), ep(102, true, true)].map((item) => ({ ...item, monitored }));
      const complete = poll(completeEpisodes, { monitored });
      expect(complete.items[0]?.work.status).toBe('fulfilled');
      const nextPoll = poll(completeEpisodes, { monitored }, complete.items[0]!.work);
      expect(nextPoll.items[0]?.work.status).toBe('fulfilled');
    }
    expect(poll([ep(101, true, true), { ...ep(102, true, false), monitored: false }]).items[0]?.work.status).toBe('inactive');
    expect(poll([]).items[0]?.work.status).toBe('inactive');
    expect(poll([{ ...ep(201, true, true), seasonNumber: 2 }]).items[0]?.work.status).toBe('inactive');
    const unknown = poll([ep(101, true, true), ep(102, true, true)], { known: false });
    expect(unknown.items[0]).toMatchObject({ work: { status: 'inactive' }, blockedReason: 'library-unknown' });
  });

  it('uses positive file evidence before unmonitored inactivity for TV and Radarr work, while incomplete or unknown remains non-fulfilled', () => {
    const previousTv = reconcile().items.find((item) => item.work.workKey === 'sonarr:4:s1')!.work;
    const capture: GrabIntent = {
      id: 'completion-capture', ownerToken: 'owner', arr: 'sonarr', indexerId: 4, guid: 'completion-release', infoHash: 'completion-hash',
      releaseTitle: 'Show S01', coverage: [{ workKey: previousTv.workKey, episodeIds: [101, 102], basis: 'explicit-episodes' }],
      status: 'active', startedAt: NOW, confirmedAt: NOW, queueDeadlineAt: LATER, lastSeenAt: LATER, queueRefs: ['download:completion'],
    };
    const runTv = (monitored: boolean, files: [boolean, boolean], known = true) => {
      const inventory = snapshot([ep(101, true, files[0]), ep(102, true, files[1])]);
      inventory.sonarr.series[0]!.series = { ...inventory.sonarr.series[0]!.series, monitored };
      inventory.sonarr.series[0]!.episodes = inventory.sonarr.series[0]!.episodes!.map((item) => ({ ...item, monitored }));
      if (!known) {
        inventory.sonarr.series[0]!.known = false;
        inventory.sonarr.series[0]!.episodes = null;
      }
      return reconcileWork({
        snapshot: inventory, queues: { sonarr: knownTvQueue([], inventory.observedAt), radarr: knownMovieQueue([], inventory.observedAt) },
        existingWorkItems: [previousTv], intents: [capture], now: inventory.observedAt, minRetryHours: 6, queueGraceMin: 30,
      });
    };
    for (const monitored of [true, false]) {
      const complete = runTv(monitored, [true, true]);
      expect(complete.items.find((item) => item.work.workKey === previousTv.workKey)?.work.status).toBe('fulfilled');
      expect(complete.intentUpdates).toContainEqual(expect.objectContaining({ id: capture.id, status: 'fulfilled' }));
    }
    const incomplete = runTv(false, [true, false]);
    expect(incomplete.items.find((item) => item.work.workKey === previousTv.workKey)?.work.status).toBe('inactive');
    expect(incomplete.intentUpdates).not.toContainEqual(expect.objectContaining({ id: capture.id, status: 'fulfilled' }));
    const unknown = runTv(false, [true, true], false);
    expect(unknown.items.find((item) => item.work.workKey === previousTv.workKey)).toMatchObject({ work: { status: previousTv.status }, blockedReason: 'library-unknown' });
    expect(unknown.intentUpdates).not.toContainEqual(expect.objectContaining({ id: capture.id, status: 'fulfilled' }));

    const previousMovie = reconcile({ inventory: snapshot([], [movie()]) }).items.find((item) => item.work.workKey === 'radarr:8')!.work;
    for (const monitored of [true, false]) {
      const inventory = snapshot([], [movie({ monitored, hasFile: true })]);
      const result = reconcileWork({ snapshot: inventory, queues: { sonarr: knownTvQueue([], inventory.observedAt), radarr: knownMovieQueue([], inventory.observedAt) }, existingWorkItems: [previousMovie], intents: [], now: inventory.observedAt, minRetryHours: 6, queueGraceMin: 30 });
      expect(result.items.find((item) => item.work.workKey === previousMovie.workKey)?.work.status).toBe('fulfilled');
    }
    const incompleteMovie = snapshot([], [movie({ monitored: false, hasFile: false })]);
    const movieResult = reconcileWork({ snapshot: incompleteMovie, queues: { sonarr: knownTvQueue([], incompleteMovie.observedAt), radarr: knownMovieQueue([], incompleteMovie.observedAt) }, existingWorkItems: [previousMovie], intents: [], now: incompleteMovie.observedAt, minRetryHours: 6, queueGraceMin: 30 });
    expect(movieResult.items.find((item) => item.work.workKey === previousMovie.workKey)?.work.status).toBe('inactive');
  });

  it('reopens cooldown for a new missing target but preserves it when targets were only removed', () => {
    const first = reconcile().items.find((item) => item.work.workKey === 'sonarr:4:s1')!.work;
    const cooldown: WorkItem = { ...first, status: 'cooldown', nextSearchAt: '2026-09-29T06:00:00.000Z' };
    const addition = reconcile({ inventory: snapshot([ep(101, true), ep(102, true), ep(103, true)]), workItems: [cooldown] });
    expect(addition.items.find((item) => item.work.workKey === cooldown.workKey)?.work.status).toBe('ready');
    const removal = reconcile({ inventory: snapshot([ep(101, true)]), workItems: [cooldown] });
    expect(removal.items.find((item) => item.work.workKey === cooldown.workKey)?.work).toMatchObject({ status: 'cooldown', nextSearchAt: cooldown.nextSearchAt });
  });

  it('checks candidate coverage against the original missing inventory, including inferred season packs', () => {
    const original = reconcile().items.find((item) => item.work.workKey === 'sonarr:4:s1')!.work.unit;
    const candidate = [{ workKey: original.key, episodeIds: [101, 102], basis: 'inferred-season-pack' as const }];
    const queued = [{ workKey: original.key, episodeIds: [101], basis: 'explicit-episodes' as const }];
    expect(candidateOverlapsQueue(candidate, queued)).toBe(true);
  });

  it('creates unavailable movies as waiting-release work, not actionable work', () => {
    const result = reconcile({ inventory: snapshot([], [movie({ isAvailable: false })]) });
    expect(result.items.find((item) => item.work.workKey === 'radarr:8')).toMatchObject({ work: { status: 'waiting-release' }, eligibleUnit: null, blockedReason: 'waiting-release' });
  });

  it('turns a disappeared external queue reservation into a review hold until review resolution', () => {
    const queue = knownTvQueue([{ downloadId: 'gone', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'downloading' } as SonarrQueueRecord]);
    const withQueue = reconcile({ tvQueue: queue });
    const oldWork = withQueue.items.find((item) => item.work.workKey === 'sonarr:4:s1')!.work;
    const oldCoverage = withQueue.items.find((item) => item.work.workKey === 'sonarr:4:s1')!.activeCoverage;
    // Prior associations are separate durable facts, passed through State on the next cycle.
    const reviewHold = reconcileWork({ snapshot: snapshot(), queues: { sonarr: knownTvQueue(), radarr: knownMovieQueue() }, existingWorkItems: [oldWork], intents: [], previousQueueCoverage: new Map([[oldWork.workKey, oldCoverage]]), now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    expect(reviewHold.items[0]).toMatchObject({ work: { status: 'manual', blockedReason: 'queue-review' }, manualReviewReason: 'queue-review', eligibleUnit: null });
    const resolved = reconcileWork({ snapshot: snapshot(), queues: { sonarr: knownTvQueue(), radarr: knownMovieQueue() }, existingWorkItems: [reviewHold.items[0]!.work], intents: [], previousQueueCoverage: new Map([[oldWork.workKey, oldCoverage]]), manualReviewKeys: new Set(), now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    expect(resolved.items[0]).toMatchObject({ work: { status: 'ready', blockedReason: null }, eligibleUnit: expect.any(Object) });
  });

  it('positively fulfills a captured episode only after the library reports hasFile', () => {
    const captured = {
      id: 'intent-1', ownerToken: 'owner', arr: 'sonarr' as const, indexerId: 4, guid: 'guid', infoHash: null, releaseTitle: 'Release',
      coverage: [{ workKey: 'sonarr:4:s1', episodeIds: [101], basis: 'explicit-episodes' as const }], status: 'awaiting-queue' as const,
      startedAt: NOW, confirmedAt: NOW, queueDeadlineAt: LATER, lastSeenAt: null, queueRefs: [],
    };
    const current = snapshot([ep(101, true, true), ep(102, false)]);
    const result = reconcileWork({ snapshot: current, queues: { sonarr: knownTvQueue(), radarr: knownMovieQueue() }, existingWorkItems: reconcile().items.map((item) => item.work), intents: [captured], now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    expect(result.intentUpdates).toContainEqual({ id: 'intent-1', status: 'fulfilled', lastSeenAt: NOW });
    expect(result.items.find((item) => item.work.workKey === 'sonarr:4:s1')?.activeCoverage).toEqual([]);
  });

  it('keeps paused, import-blocked, and future queue states as holds rather than empty work', () => {
    for (const [record, reason] of [
      [{ downloadId: 'd', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'paused' }, 'queue-active'],
      [{ downloadId: 'd', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'downloading', trackedDownloadState: 'importBlocked' }, 'queue-active'],
      [{ downloadId: 'd', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'future-arr-state' }, 'queue-ambiguous'],
    ] as Array<[SonarrQueueRecord, string]>) {
      const result = reconcile({ tvQueue: knownTvQueue([record]) });
      expect(result.items.find((item) => item.work.workKey === 'sonarr:4:s1')).toMatchObject({ blockedReason: reason, eligibleUnit: null });
    }
  });

  it('source-qualifies association decisions before applying unrelated or matched outcomes', () => {
    const sonarrQueue = knownTvQueue([{ id: 7, title: 'Unidentified Sonarr item', status: 'downloading' } as SonarrQueueRecord]);
    const radarrQueue = knownMovieQueue([{ id: 7, title: 'Unidentified Radarr item', status: 'downloading' } as RadarrQueueRecord]);
    const radarrUnrelated: AssociationDecision = {
      arr: 'radarr', queueRef: 'row:7', outcome: 'unrelated', mediaReferences: [], workReferences: [],
      potentialScope: 'unknown', seasonNumber: null, episodeIds: null, basis: null, uncertainty: null,
    };
    const result = reconcileWork({
      snapshot: snapshot(), queues: { sonarr: sonarrQueue, radarr: radarrQueue }, existingWorkItems: [], intents: [],
      associationDecisions: [radarrUnrelated], now: NOW, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(result.items.find((item) => item.work.workKey === 'sonarr:4:s1')).toMatchObject({
      blockedReason: 'queue-ambiguous', eligibleUnit: null,
    });

    const sameSourceUnrelated: AssociationDecision = { ...radarrUnrelated, arr: 'sonarr' };
    const resolved = reconcileWork({
      snapshot: snapshot(), queues: { sonarr: sonarrQueue, radarr: knownMovieQueue() }, existingWorkItems: [], intents: [],
      associationDecisions: [sameSourceUnrelated], now: NOW, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(resolved.items.find((item) => item.work.workKey === 'sonarr:4:s1')).toMatchObject({
      blockedReason: null, eligibleUnit: expect.any(Object),
    });

    const sharedDownloadRefSonarr = knownTvQueue([{ downloadId: '42', title: 'Unidentified Sonarr item', status: 'downloading' } as SonarrQueueRecord]);
    const sharedDownloadRefRadarr = knownMovieQueue([{ downloadId: '42', title: 'Unidentified Radarr item', status: 'downloading' } as RadarrQueueRecord]);
    const downloadCollision = reconcileWork({
      snapshot: snapshot(), queues: { sonarr: sharedDownloadRefSonarr, radarr: sharedDownloadRefRadarr }, existingWorkItems: [], intents: [],
      associationDecisions: [{ ...radarrUnrelated, queueRef: 'download:42' }], now: NOW, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(downloadCollision.items.find((item) => item.work.workKey === 'sonarr:4:s1')).toMatchObject({
      blockedReason: 'queue-ambiguous', eligibleUnit: null,
    });
  });

  it('keeps initial unidentified queue ambiguity ready for one fuzzy-unrelated association pass', () => {
    const sonarrQueue = knownTvQueue([{
      downloadId: 'unidentified-job', title: 'Unidentified item', status: 'downloading',
      trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading',
    } as SonarrQueueRecord]);
    const first = reconcileWork({
      snapshot: snapshot(), queues: { sonarr: sonarrQueue, radarr: knownMovieQueue() }, existingWorkItems: [], intents: [],
      now: NOW, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(first.items[0]).toMatchObject({
      work: { status: 'ready', blockedReason: 'queue-ambiguous' }, manualReviewReason: 'queue-review', eligibleUnit: null,
    });

    const unrelated: AssociationDecision = {
      arr: 'sonarr', queueRef: 'download:unidentified-job', outcome: 'unrelated', mediaReferences: [], workReferences: [],
      potentialScope: 'unknown', seasonNumber: null, episodeIds: null, basis: null, uncertainty: null,
    };
    const afterAssociation = reconcileWork({
      snapshot: snapshot(), queues: { sonarr: sonarrQueue, radarr: knownMovieQueue() },
      existingWorkItems: first.items.map((item) => item.work), intents: [], associationDecisions: [unrelated],
      now: LATER, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(afterAssociation.items[0]).toMatchObject({
      work: { status: 'ready', blockedReason: null }, eligibleUnit: expect.any(Object),
    });
  });

  it('retains submitting coverage with an empty queue and escalates it to uncertain at grace expiry', () => {
    const pending = {
      id: 'pending', ownerToken: 'owner', arr: 'sonarr' as const, indexerId: 3, guid: 'guid', infoHash: null, releaseTitle: 'Release',
      coverage: [{ workKey: 'sonarr:4:s1', episodeIds: [101], basis: 'explicit-episodes' as const }], status: 'submitting' as const,
      startedAt: NOW, confirmedAt: null, queueDeadlineAt: LATER, lastSeenAt: null, queueRefs: [],
    };
    const first = reconcileWork({ snapshot: snapshot([ep(101, true)]), queues: { sonarr: knownTvQueue(), radarr: knownMovieQueue() }, existingWorkItems: [], intents: [pending], now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    expect(first.items[0]).toMatchObject({ blockedReason: 'active-intent', eligibleUnit: null, activeCoverage: pending.coverage });
    const expired = reconcileWork({ snapshot: snapshot([ep(101, true)]), queues: { sonarr: knownTvQueue(), radarr: knownMovieQueue() }, existingWorkItems: first.items.map((item) => item.work), intents: [pending], now: '2026-09-29T00:31:00.000Z', minRetryHours: 6, queueGraceMin: 30 });
    expect(expired.intentUpdates).toContainEqual({ id: 'pending', status: 'uncertain' });
    expect(expired.items[0]?.manualReviewReason).toBe('queue-review');
  });

  it('projects an immutable captured episode reservation onto its current season after renumbering', () => {
    const first = reconcile({ inventory: snapshot([ep(101, true)]) });
    const original = first.items.find((row) => row.work.workKey === 'sonarr:4:s1')!.work;
    const captured = {
      id: 'capture', ownerToken: 'owner', arr: 'sonarr' as const, indexerId: 3, guid: 'guid', infoHash: 'hash', releaseTitle: 'Release',
      coverage: [{ workKey: original.workKey, episodeIds: [101], basis: 'explicit-episodes' as const }], status: 'uncertain' as const,
      startedAt: NOW, confirmedAt: null, queueDeadlineAt: LATER, lastSeenAt: null, queueRefs: [],
    };
    const moved = snapshot([{ ...ep(101, true), seasonNumber: 2 }]);
    const result = reconcileWork({ snapshot: moved, queues: { sonarr: knownTvQueue(), radarr: knownMovieQueue() }, existingWorkItems: [original], intents: [captured], now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    const nextSeason = result.items.find((row) => row.work.workKey === 'sonarr:4:s2');
    expect(nextSeason).toMatchObject({ eligibleUnit: null, activeCoverage: [{ workKey: 'sonarr:4:s2', episodeIds: [101] }] });
    expect(result.intentUpdates).toEqual([]); // the stored receipt remains keyed to its original unit
  });

  it('does not fail an uncertain submission from an unrelated failed job with overlapping episode coverage', () => {
    const work = reconcile({ inventory: snapshot([ep(101, true)]) }).items[0]!.work;
    const intent = {
      id: 'uncertain', ownerToken: 'owner', arr: 'sonarr' as const, indexerId: 2, guid: 'capture-guid', infoHash: null, releaseTitle: 'Capture',
      coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' as const }], status: 'uncertain' as const,
      startedAt: NOW, confirmedAt: null, queueDeadlineAt: '2026-09-29T01:00:00.000Z', lastSeenAt: null, queueRefs: [],
    };
    const failedQueue = knownTvQueue([{ id: 5, downloadId: 'unrelated-job', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'failed' } as SonarrQueueRecord]);
    const result = reconcileWork({ snapshot: snapshot([ep(101, true)]), queues: { sonarr: failedQueue, radarr: knownMovieQueue() }, existingWorkItems: [work], intents: [intent], now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    expect(result.intentUpdates).not.toContainEqual(expect.objectContaining({ id: intent.id, status: 'failed' }));
    expect(result.items[0]?.activeCoverage).toEqual(intent.coverage);
    expect(result.items[0]?.eligibleUnit).toBeNull();
    const unrelatedActive = reconcileWork({ snapshot: snapshot([ep(101, true)]), queues: { sonarr: knownTvQueue([{ id: 5, downloadId: 'unrelated-job', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'downloading' } as SonarrQueueRecord]), radarr: knownMovieQueue() }, existingWorkItems: [work], intents: [intent], now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    expect(unrelatedActive.intentUpdates).toEqual([]);
    const laterEmpty = reconcileWork({ snapshot: snapshot([ep(101, true)]), queues: { sonarr: knownTvQueue(), radarr: knownMovieQueue() }, existingWorkItems: result.items.map((item) => item.work), intents: [intent], previousQueueCoverage: new Map([[work.workKey, result.items[0]!.queueCoverage]]), previousQueueFailureRefs: new Map([[work.workKey, result.items[0]!.queueFailureRefs]]), now: LATER, minRetryHours: 6, queueGraceMin: 30 });
    expect(laterEmpty.items[0]?.activeCoverage).toEqual(intent.coverage);
    expect(laterEmpty.intentUpdates).not.toContainEqual(expect.objectContaining({ id: intent.id, status: 'failed' }));
    const linkedIntent = { ...intent, queueRefs: ['download:related-job'] };
    const linkedFailedQueue = knownTvQueue([{ id: 6, downloadId: 'related-job', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'failed' } as SonarrQueueRecord]);
    const linkedFailure = reconcileWork({ snapshot: snapshot([ep(101, true)]), queues: { sonarr: linkedFailedQueue, radarr: knownMovieQueue() }, existingWorkItems: [work], intents: [linkedIntent], now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    expect(linkedFailure.intentUpdates).not.toContainEqual(expect.objectContaining({ id: intent.id, status: 'failed' }));
    expect(linkedFailure.items[0]).toMatchObject({ manualReviewReason: 'queue-review', eligibleUnit: null });
    expect(linkedFailure.items[0]?.activeCoverage).toEqual(intent.coverage);
    const linkedRepeated = reconcileWork({ snapshot: snapshot([ep(101, true)]), queues: { sonarr: linkedFailedQueue, radarr: knownMovieQueue() }, existingWorkItems: [linkedFailure.items[0]!.work], intents: [linkedIntent], previousQueueFailureRefs: new Map([[work.workKey, linkedFailure.items[0]!.queueFailureRefs]]), now: '2026-09-29T00:02:00.000Z', minRetryHours: 6, queueGraceMin: 30 });
    expect(linkedRepeated.intentUpdates).not.toContainEqual(expect.objectContaining({ id: intent.id, status: 'failed' }));
    expect(linkedRepeated.items[0]?.activeCoverage).toEqual(intent.coverage);
  });

  it('reviews a vanished target even when another episode from the same prior queue remains', () => {
    const firstQueue = knownTvQueue([
      { downloadId: 'two-episode-job', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'downloading' } as SonarrQueueRecord,
      { downloadId: 'two-episode-job', seriesId: 4, episodeId: 102, seasonNumber: 1, status: 'downloading' } as SonarrQueueRecord,
    ]);
    const initial = reconcile({ tvQueue: firstQueue });
    const firstRow = initial.items.find((row) => row.work.workKey === 'sonarr:4:s1')!;
    const remainingQueue = knownTvQueue([{ downloadId: 'two-episode-job', seriesId: 4, episodeId: 102, seasonNumber: 1, status: 'downloading' } as SonarrQueueRecord]);
    const next = reconcileWork({ snapshot: snapshot(), queues: { sonarr: remainingQueue, radarr: knownMovieQueue() }, existingWorkItems: [firstRow.work], intents: [], previousQueueCoverage: new Map([[firstRow.work.workKey, firstRow.queueCoverage]]), now: LATER, minRetryHours: 6, queueGraceMin: 30 });
    expect(next.items[0]).toMatchObject({ manualReviewReason: 'queue-review', work: { blockedReason: 'queue-review' } });
    expect(next.items[0]?.activeCoverage).toEqual([{ workKey: 'sonarr:4:s1', episodeIds: [101, 102], basis: 'explicit-episodes' }]);
    const stillHeld = reconcileWork({ snapshot: snapshot(), queues: { sonarr: remainingQueue, radarr: knownMovieQueue() }, existingWorkItems: [next.items[0]!.work], intents: [], previousQueueCoverage: new Map([[firstRow.work.workKey, next.items[0]!.queueCoverage]]), manualReviewKeys: new Set([firstRow.work.workKey]), now: '2026-09-29T00:10:00.000Z', minRetryHours: 6, queueGraceMin: 30 });
    expect(stillHeld.items[0]).toMatchObject({ work: { status: 'manual', blockedReason: 'queue-review' }, activeCoverage: [{ episodeIds: [101, 102] }] });
  });

  it('does not repeat a definitive queue failure backoff event and scopes it to currently missing episodes', () => {
    const failed = knownTvQueue([{ id: 99, downloadId: 'failed-job', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'failed' } as SonarrQueueRecord]);
    const original = reconcile({ inventory: snapshot([ep(101, true), ep(102, true)]) }).items[0]!.work;
    const first = reconcileWork({ snapshot: snapshot([ep(101, true), ep(102, true)]), queues: { sonarr: failed, radarr: knownMovieQueue() }, existingWorkItems: [original], intents: [], now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    const firstRow = first.items[0]!;
    expect(firstRow.work).toMatchObject({ status: 'backoff', failCount: 1 });
    expect(firstRow.queueFailureRefs).toEqual([JSON.stringify(['download:failed-job', 101])]);
    const repeated = reconcileWork({ snapshot: snapshot([ep(101, true), ep(102, true)]), queues: { sonarr: failed, radarr: knownMovieQueue() }, existingWorkItems: [firstRow.work], intents: [], previousQueueFailureRefs: new Map([[original.workKey, firstRow.queueFailureRefs]]), now: '2026-09-29T00:02:00.000Z', minRetryHours: 6, queueGraceMin: 30 });
    expect(repeated.items[0]?.work).toMatchObject({ failCount: 1, nextSearchAt: firstRow.work.nextSearchAt });

    const alreadyFiled = snapshot([ep(101, true, true), ep(102, true)]);
    const remaining = reconcileWork({ snapshot: alreadyFiled, queues: { sonarr: failed, radarr: knownMovieQueue() }, existingWorkItems: [original], intents: [], now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    expect(remaining.items[0]?.work.status).toBe('ready');
    expect(remaining.items[0]?.work.failCount).toBe(0);
  });

  it('moves failed-job history with the exact episode across seasons without suppressing another episode from that job', () => {
    const oldSeason = reconcile({ inventory: snapshot([ep(101, true)]) }).items[0]!.work;
    const remappedInventory = snapshot([{ ...ep(101, true), seasonNumber: 2 }, { ...ep(201, true), seasonNumber: 2 }]);
    const sameFailedJob = knownTvQueue([
      { id: 11, downloadId: 'job-a', seriesId: 4, episodeId: 101, seasonNumber: 2, status: 'failed' } as SonarrQueueRecord,
      { id: 12, downloadId: 'job-a', seriesId: 4, episodeId: 201, seasonNumber: 2, status: 'failed' } as SonarrQueueRecord,
    ]);
    const processedEpisode101 = JSON.stringify(['download:job-a', 101]);
    const first = reconcileWork({
      snapshot: remappedInventory, queues: { sonarr: sameFailedJob, radarr: knownMovieQueue() }, existingWorkItems: [oldSeason], intents: [],
      previousQueueFailureRefs: new Map([[oldSeason.workKey, [processedEpisode101]]]), now: NOW, minRetryHours: 6, queueGraceMin: 30,
    });
    expect(first.items.find((row) => row.work.workKey === 'sonarr:4:s2')?.work).toMatchObject({ status: 'backoff', failCount: 1 });
    expect(first.items.find((row) => row.work.workKey === 'sonarr:4:s2')?.queueFailureRefs).toEqual([processedEpisode101, JSON.stringify(['download:job-a', 201])]);
    const repeated = reconcileWork({
      snapshot: remappedInventory, queues: { sonarr: sameFailedJob, radarr: knownMovieQueue() }, existingWorkItems: first.items.map((row) => row.work), intents: [],
      previousQueueFailureRefs: new Map(first.items.map((row) => [row.work.workKey, row.queueFailureRefs])), now: '2026-09-29T00:02:00.000Z', minRetryHours: 6, queueGraceMin: 30,
    });
    expect(repeated.items.find((row) => row.work.workKey === 'sonarr:4:s2')?.work).toMatchObject({ failCount: 1, nextSearchAt: first.items.find((row) => row.work.workKey === 'sonarr:4:s2')?.work.nextSearchAt });
  });

  it('does not send terminal updates to already closed intent history', () => {
    const movieInventory = snapshot([], [movie({ hasFile: true })]);
    const oldWork: WorkItem = { ...reconcile({ inventory: snapshot([], [movie()]) }).items.find((row) => row.work.workKey === 'radarr:8')!.work, status: 'fulfilled' };
    const failed = { id: 'old-failed', ownerToken: 'owner', arr: 'radarr' as const, indexerId: 1, guid: 'g', infoHash: null, releaseTitle: 'old', coverage: [{ workKey: oldWork.workKey, episodeIds: null, basis: null }], status: 'failed' as const, startedAt: NOW, confirmedAt: null, queueDeadlineAt: LATER, lastSeenAt: null, queueRefs: [] };
    const result = reconcileWork({ snapshot: movieInventory, queues: { sonarr: knownTvQueue(), radarr: knownMovieQueue() }, existingWorkItems: [oldWork], intents: [failed], now: NOW, minRetryHours: 6, queueGraceMin: 30 });
    expect(result.intentUpdates).toEqual([]);
  });
});
