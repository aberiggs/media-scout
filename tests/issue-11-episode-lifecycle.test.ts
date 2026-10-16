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
  const plannedTargets: number[][] = [];
  const searches: string[] = [];
  const makeRunner = () => new Runner({
    state, now: () => now, logger: pino({ enabled: false }),
    watcher: { getSnapshot: async (): Promise<LibrarySnapshot> => ({ observedAt: now.toISOString(), sonarr: { known: true, series: [{ series, known: true, episodes }] }, radarr: { known: true, movies: [] } }) },
    sonarr: { getQueue: async () => queue }, radarr: { getQueue: async () => [] },
    planner: { planGroup: async ({ group }: { group: WorkGroup }) => {
      const ids = group.targets.flatMap((unit) => unit.season?.missing.map((target) => target.episodeId) ?? []);
      plannedTargets.push(ids);
      return [{ query: `Synthetic Show targets ${ids.join(',')}`, categories: [5000], targetIndices: group.dueTargetIndices }];
    } },
    picker: { pickGroup: async () => ({ verdict: 'skip', releaseIndices: [], manualTargetIndices: [], deferredTargetIndices: [], reason: 'test evaluation complete' }) },
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
    async poll() { return makeRunner().cycle(); },
    restart() { state.close(); state = State.open(path); }, close() { state.close(); },
  };
}

describe('issue #11 persisted weekly episode lifecycle', () => {
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
