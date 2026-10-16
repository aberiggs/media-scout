import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { Runner, type RunnerDeps } from '../src/core/runner';
import { State } from '../src/core/state';
import { episodeSchema, seriesSchema, type Episode, type SonarrQueueRecord } from '../src/types/sonarr';
import type { LibrarySnapshot } from '../src/core/watcher';
import type { WorkGroup } from '../src/core/group-types';
import type { Release } from '../src/types/prowlarr';
import { ApiError } from '../src/http';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/prowlarr-release.json', import.meta.url), 'utf8')) as Release;
const series = seriesSchema.parse({ id: 1, tvdbId: 123, title: 'Synthetic Show', titleSlug: 'synthetic', monitored: true, seriesType: 'standard', seasons: [], alternateTitles: [], status: 'continuing' });
const episode = (id: number, seasonNumber: number, episodeNumber: number, airDateUtc: string, hasFile = false): Episode => episodeSchema.parse({
  id, seriesId: 1, seasonNumber, episodeNumber, airDate: airDateUtc.slice(0, 10), airDateUtc, hasFile, monitored: true, title: `Episode ${episodeNumber}`,
});
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function replay() {
  const directory = mkdtempSync(join(tmpdir(), 'media-scout-issue11-'));
  directories.push(directory);
  const path = join(directory, 'isolated.db');
  let state = State.open(path);
  let now = new Date('2026-10-15T00:01:00.000Z');
  let episodes = [episode(11, 1, 1, '2025-01-01T23:00:00Z', true), episode(101, 2, 1, '2026-10-15T23:00:00Z'), episode(102, 2, 2, '2026-10-22T23:00:00Z')];
  let queue: SonarrQueueRecord[] = [];
  let emptyResults = false;
  let libraryMode: 'known' | 'source-unknown' | 'episodes-unknown' = 'known';
  let queueUnknown = false;
  let planError: Error | null = null;
  let pickerError: Error | null = null;
  const plannedTargets: number[][] = [];
  const searches: string[] = [];
  const makeRunner = () => new Runner({
    state, now: () => now, logger: pino({ enabled: false }),
    watcher: { getSnapshot: async (): Promise<LibrarySnapshot> => ({ observedAt: now.toISOString(), sonarr: libraryMode === 'source-unknown'
      ? { known: false, series: [] } : { known: true, series: [{ series, known: libraryMode === 'known', episodes: libraryMode === 'known' ? episodes : null }] }, radarr: { known: true, movies: [] } }) },
    sonarr: { getQueue: async () => { if (queueUnknown) throw new Error('synthetic queue unavailable'); return queue; } }, radarr: { getQueue: async () => [] },
    planner: { planGroup: async ({ group }: { group: WorkGroup }) => {
      const ids = group.targets.flatMap((unit) => unit.season?.missing.map((target) => target.episodeId) ?? []);
      plannedTargets.push(ids);
      if (planError) throw planError;
      return [{ query: `Synthetic Show targets ${ids.join(',')}`, categories: [5000], targetIndices: group.dueTargetIndices }];
    } },
    picker: { pickGroup: async () => { if (pickerError) throw pickerError; return { verdict: 'skip', releaseIndices: [], manualTargetIndices: [], deferredTargetIndices: [], reason: 'test evaluation complete' }; } },
    prowlarr: {
      getDownloadClients: async () => [{ id: 1, name: 'tv' }], getIndexers: async () => [{ id: 5, enable: true }], getIndexerStatuses: async () => [],
      search: async ({ query }: { query: string }) => { searches.push(query); return emptyResults ? [] : [
        { ...fixture, guid: 'synthetic-episode-1', title: 'Synthetic.Show.S02E01.1080p' },
        { ...fixture, guid: 'synthetic-episode-2', title: 'Synthetic.Show.S02E02.1080p' },
      ]; },
      grab: async () => { throw new Error('Replay must never submit downloads'); },
    },
    config: { dryRun: true, minRetryHours: 6, failureBackoffMin: 5, failureBackoffMaxMin: 60, queueGraceMin: 30 },
    clientNames: { tv: 'tv', movie: 'movie' },
  } as unknown as RunnerDeps);
  return {
    get state() { return state; }, get episodes() { return episodes; }, plannedTargets, searches,
    at(value: string) { now = new Date(value); },
    setEpisodes(value: Episode[]) { episodes = value; }, setQueue(value: SonarrQueueRecord[]) { queue = value; },
    setEmptyResults(value: boolean) { emptyResults = value; },
    setLibraryMode(value: typeof libraryMode) { libraryMode = value; }, setQueueUnknown(value: boolean) { queueUnknown = value; },
    failPlan(error: Error | null) { planError = error; }, failPicker(error: Error | null) { pickerError = error; },
    async poll() { return makeRunner().cycle(); },
    restart() { state.close(); state = State.open(path); }, close() { state.close(); },
  };
}

describe('issue #11 persisted weekly episode lifecycle', () => {
  it.each([
    ['planner', false, '2026-10-22T23:05:00.000Z'], ['picker', false, '2026-10-22T23:05:00.000Z'],
    ['planner', true, '2026-10-22T23:20:00.000Z'], ['picker', true, '2026-10-22T23:20:00.000Z'],
  ] as const)('does not let an E2 %s failure (quota=%s) reset E1 availability timing', async (stage, quota, deadline) => {
    const run = replay();
    try {
      run.setEmptyResults(true);
      run.at('2026-10-22T22:00:00.000Z');
      await run.poll();
      const error = quota ? new ApiError(429, 'https://synthetic.invalid', '', 1200) : new Error('synthetic failure');
      run.setEmptyResults(false);
      if (stage === 'planner') run.failPlan(error); else run.failPicker(error);
      run.at('2026-10-22T23:00:00.000Z');
      await run.poll();
      expect(run.state.getWorkItem('sonarr:1:s2')).toMatchObject({ status: 'backoff', nextSearchAt: deadline });
      run.restart(); run.failPlan(null); run.failPicker(null);
      run.at(deadline);
      await run.poll();
      expect(run.plannedTargets).toEqual([[101], [102], [102]]);
      expect(run.state.listEpisodeProgress('sonarr:1:s2')[0]!.nextSearchAt).toBe('2026-10-23T04:00:00.000Z');
    } finally { run.close(); }
  });

  it.each(['source-unknown', 'episodes-unknown', 'queue-unknown'] as const)('does not spend or lose progress during %s observations', async (mode) => {
    const run = replay();
    try {
      run.setEmptyResults(true);
      run.at('2026-10-22T22:00:00.000Z');
      await run.poll();
      const progress = () => run.state.listEpisodeProgress().map(({ episodeId, hasFile, lastSearchAt, nextSearchAt }) => ({ episodeId, hasFile, lastSearchAt, nextSearchAt }));
      const before = progress();
      run.at('2026-10-22T23:00:00.000Z');
      if (mode === 'queue-unknown') run.setQueueUnknown(true); else run.setLibraryMode(mode);
      await run.poll();
      expect(run.plannedTargets).toEqual([[101]]);
      expect(progress()).toEqual(before);
      expect(run.state.listGrabIntents()).toEqual([]);
      run.setLibraryMode('known'); run.setQueueUnknown(false);
      run.at('2026-10-22T23:01:00.000Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[101], [102]]);
    } finally { run.close(); }
  });

  it('allows E2 beside a healthy E1 download but preserves a vanished-job safety hold', async () => {
    const run = replay();
    try {
      run.setEmptyResults(true);
      run.at('2026-10-22T22:00:00.000Z');
      run.setQueue([{ downloadId: 'synthetic-e1', seriesId: 1, episodeId: 101, seasonNumber: 2, status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading' }]);
      await run.poll();
      expect(run.searches).toEqual([]);
      run.at('2026-10-22T23:00:00.000Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[102]]);
      run.setQueue([]);
      run.at('2026-10-23T06:00:00.000Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[102]]);
      expect(run.state.getWorkItem('sonarr:1:s2')).toMatchObject({ status: 'manual', blockedReason: 'queue-review' });
      expect(run.state.listManualReview()).toMatchObject([{ reason: 'queue-review' }]);
      expect(run.state.listWorkQueueObservations()[0]!.coverage).toMatchObject([{ episodeIds: [101] }]);
    } finally { run.close(); }
  });

  it('retries an ordinary empty TV search automatically instead of blocking the season', async () => {
    const run = replay();
    try {
      run.setEmptyResults(true);
      run.at('2026-10-15T23:00:00.000Z');
      await run.poll();
      expect(run.state.listManualReview()).toEqual([]);
      expect(run.state.getWorkItem('sonarr:1:s2')).toMatchObject({ status: 'cooldown', lastOutcome: 'release-unavailable', nextSearchAt: '2026-10-16T05:00:00.000Z' });
      run.restart();
      run.at('2026-10-16T04:59:59.999Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[101]]);
      run.at('2026-10-16T05:00:00.000Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[101], [101]]);
      expect(run.state.listGrabIntents()).toEqual([]);
    } finally { run.close(); }
  });

  it('searches newly aired E2 without resetting E1 availability cooldown, and persists separate deadlines', async () => {
    const run = replay();
    try {
      run.setEmptyResults(true);
      run.at('2026-10-22T22:00:00.000Z');
      await run.poll();
      run.restart();
      run.at('2026-10-22T23:00:00.000Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[101], [102]]);
      expect(run.state.listEpisodeProgress('sonarr:1:s2')).toMatchObject([
        { episodeId: 101, nextSearchAt: '2026-10-23T04:00:00.000Z' },
        { episodeId: 102, nextSearchAt: '2026-10-23T05:00:00.000Z' },
      ]);
      expect(run.state.listManualReview()).toEqual([]);
      run.restart();
      run.at('2026-10-23T04:00:00.000Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[101], [102], [101]]);
      expect(run.state.listGrabIntents()).toEqual([]);
    } finally { run.close(); }
  });

  it('waits for actual airtime, retains future inventory, and searches only the newly aired episode after restart', async () => {
    const run = replay();
    try {
      await run.poll();
      expect(run.searches).toEqual([]);
      expect(run.state.getWorkItem('sonarr:1:s2')).toMatchObject({ status: 'waiting-release' });
      expect(run.state.getWorkItem('sonarr:1:s2')!.unit.season!.missing.map((target) => target.episodeId)).toEqual([101, 102]);
      run.at('2026-10-15T23:00:00.000Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[101]]);
      run.setQueue([{ downloadId: 'synthetic-e1', seriesId: 1, episodeId: 101, seasonNumber: 2, status: 'downloading', trackedDownloadStatus: 'ok', trackedDownloadState: 'downloading' }]);
      run.at('2026-10-15T23:05:00.000Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[101]]);
      run.setEpisodes(run.episodes.map((target) => target.id === 101 ? { ...target, hasFile: true } : target));
      run.setQueue([]);
      run.at('2026-10-15T23:10:00.000Z');
      await run.poll();
      expect(run.state.listManualReview()).toEqual([]);
      expect(run.state.getWorkItem('sonarr:1:s2')).toMatchObject({ status: 'waiting-release' });
      run.restart();
      run.at('2026-10-22T22:59:59.999Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[101]]);
      run.at('2026-10-22T23:00:00.000Z');
      await run.poll();
      expect(run.plannedTargets).toEqual([[101], [102]]);
      expect(run.searches).toEqual(['Synthetic Show targets 101', 'Synthetic Show targets 102']);
      expect(run.state.listManualReview()).toEqual([]);
      expect(run.state.listGrabIntents()).toEqual([]);
    } finally { run.close(); }
  });
});
