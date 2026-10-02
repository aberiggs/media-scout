import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { State } from '../src/core/state';
import { reconcileWork } from '../src/core/work-queue';
import type { QueueRead, WorkItem } from '../src/core/work-queue-types';
import type { LibrarySnapshot } from '../src/core/watcher';
import type { Episode, Series, SonarrQueueRecord } from '../src/types/sonarr';
import type { RadarrQueueRecord } from '../src/types/radarr';

const START = '2026-09-29T00:00:00.000Z';
const KEY = 'sonarr:4:s1';

const series = { id: 4, tvdbId: 44, title: 'Show', titleSlug: 'show', seriesType: 'standard', monitored: true, seasons: [], alternateTitles: [] } as Series;
const episode = (id: number): Episode => ({ id, seriesId: 4, seasonNumber: 1, episodeNumber: id - 100, absoluteEpisodeNumber: null, title: `E${id}`, airDate: '2020-01-01', monitored: true, hasFile: false });

function snapshot(at: string): LibrarySnapshot {
  return {
    observedAt: at,
    sonarr: { known: true, series: [{ series, known: true, episodes: [episode(101), episode(102)] }] },
    radarr: { known: true, movies: [] },
  };
}

function tvQueue(records: SonarrQueueRecord[], at: string): QueueRead<SonarrQueueRecord> {
  return { kind: 'known', records, observedAt: at };
}

const emptyMovies: QueueRead<RadarrQueueRecord> = { kind: 'known', records: [], observedAt: START };
const jobA = { downloadId: 'job-A', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'downloading' } as SonarrQueueRecord;
const jobB = { downloadId: 'job-B', seriesId: 4, episodeId: 102, seasonNumber: 1, status: 'downloading' } as SonarrQueueRecord;
const failedJobC = { downloadId: 'job-C', seriesId: 4, episodeId: 101, seasonNumber: 1, status: 'failed' } as SonarrQueueRecord;

function observationMaps(state: State) {
  const observations = state.listWorkQueueObservations();
  return {
    coverage: new Map(observations.map((item) => [item.workKey, item.coverage])),
    failureRefs: new Map(observations.map((item) => [item.workKey, item.failedQueueRefs])),
  };
}

function heldIds(coverage: Array<{ workKey: string; episodeIds: number[] | null }>): number[] {
  return coverage.filter((item) => item.workKey === KEY).flatMap((item) => item.episodeIds ?? []).sort((a, b) => a - b);
}

describe('external queue history without local intents', () => {
  it('does not let a different failed job erase a vanished historical reservation across polls and reopen', () => {
    let db = new Database(':memory:');
    let state = new State(db);
    const listIntents = () => {
      expect(state.listGrabIntents()).toEqual([]);
    };

    const observe = (at: string, records: SonarrQueueRecord[], reviewHeld = false) => {
      listIntents();
      const queues = { sonarr: tvQueue(records, at), radarr: { ...emptyMovies, observedAt: at } };
      const previous = observationMaps(state);
      const result = reconcileWork({
        snapshot: snapshot(at),
        queues,
        existingWorkItems: state.listWorkItems(),
        intents: state.listGrabIntents(),
        previousQueueCoverage: previous.coverage,
        previousQueueFailureRefs: previous.failureRefs,
        manualReviewKeys: reviewHeld ? new Set([KEY]) : undefined,
        now: at,
        minRetryHours: 6,
        failureBackoffMin: 5,
        failureBackoffMaxMin: 60,
        queueGraceMin: 30,
      });
      const row = result.items.find((item) => item.work.workKey === KEY);
      if (!row) throw new Error('expected current Sonarr work');
      const token = state.claimUnit(KEY, new Date(at));
      if (!token) throw new Error('expected unit claim');
      state.applyWorkReconciliation({ key: KEY, token, work: row.work, intentUpdates: [] });
      state.applyWorkQueueObservation({ key: KEY, token, observedAt: at, known: true, coverage: row.queueCoverage, failedQueueRefs: row.queueFailureRefs });
      state.releaseClaim(KEY, token);
      listIntents();
      return row;
    };

    // Both independent external downloads establish historical target coverage. No local
    // submission exists to mask a later loss of that external evidence.
    const first = observe(START, [jobA, jobB]);
    expect(heldIds(first.queueCoverage)).toEqual([101, 102]);
    expect(heldIds(state.listWorkQueueObservations()[0]!.coverage)).toEqual([101, 102]);
    listIntents();

    const failedAt = '2026-09-29T00:05:00.000Z';
    const second = observe(failedAt, [failedJobC, jobB]);
    const persistedAfterFailure = state.listWorkQueueObservations()[0]!.coverage;
    // C's failure is not evidence that historical A ended; A's disappearance is a review hold.
    expect(heldIds(second.queueCoverage)).toEqual([101, 102]);
    expect(heldIds(persistedAfterFailure)).toEqual([101, 102]);
    expect(second.manualReviewReason).toBe('queue-review');
    expect(second.work.blockedReason).toBe('queue-review');
    listIntents();

    const repeated = observe('2026-09-29T00:06:00.000Z', [failedJobC, jobB], true);
    expect(repeated.work.blockedReason).toBe('queue-review');
    expect(heldIds(repeated.queueCoverage)).toEqual([101, 102]);
    listIntents();

    const snapshotBytes = db.serialize();
    db.close();
    db = new Database(snapshotBytes);
    state = new State(db);
    expect(state.listGrabIntents()).toEqual([]);
    expect(heldIds(state.listWorkQueueObservations()[0]!.coverage)).toEqual([101, 102]);

    // Move past C's five-minute failure backoff. Its repeated presence still cannot
    // clear A's vanished-job review hold or make episode 101 eligible for replacement.
    const expiredAt = '2026-09-29T00:11:00.000Z';
    const afterExpiry = observe(expiredAt, [failedJobC, jobB], true);
    expect(afterExpiry.work.failCount).toBe(1);
    expect(afterExpiry.work.status).toBe('manual');
    expect(afterExpiry.manualReviewReason).toBe('queue-review');
    expect(afterExpiry.eligibleUnit).toBeNull();
    expect(heldIds(afterExpiry.queueCoverage)).toEqual([101, 102]);
    expect(state.getWorkItem(KEY)?.missingFingerprint).toBe(afterExpiry.work.missingFingerprint);
    listIntents();

    // Attempt a genuinely different release against the current fingerprint and claim.
    // The durable historical queue reservation/review hold must still reject it.
    const token = state.claimUnit(KEY, new Date(expiredAt));
    expect(token).toBeTypeOf('string');
    const currentWork: WorkItem | null = state.getWorkItem(KEY);
    expect(currentWork).not.toBeNull();
    const attempt = state.beginGrab({
      key: KEY,
      token: token!,
      fingerprint: currentWork!.missingFingerprint,
      release: { arr: 'sonarr', indexerId: 99, guid: 'replacement-release', infoHash: 'replacement-hash', releaseTitle: 'Replacement' },
      coverage: [{ workKey: KEY, episodeIds: [101], basis: 'explicit-episodes' }],
      now: expiredAt,
      deadline: '2026-09-29T00:41:00.000Z',
    });
    expect(attempt).toEqual({ ok: false, reason: 'work-held-for-review' });
    expect(state.listGrabIntents()).toEqual([]);
    state.releaseClaim(KEY, token!);
    db.close();
  });
});
