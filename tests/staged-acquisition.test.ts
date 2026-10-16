import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { z } from 'zod';
import { Runner, type RunnerDeps } from '../src/core/runner';
import { Planner } from '../src/core/planner';
import { Picker } from '../src/core/picker';
import { State } from '../src/core/state';
import type { LLMClient } from '../src/clients/llm';
import { ApiError } from '../src/http';
import type { Episode } from '../src/types/sonarr';
import type { Release } from '../src/types/prowlarr';

const releaseFixture = JSON.parse(readFileSync(new URL('./fixtures/prowlarr-release.json', import.meta.url), 'utf8')) as Release;
const opened: State[] = [];
const directories: string[] = [];
afterEach(() => { for (const state of opened.splice(0)) state.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const at = '2026-10-15T23:00:00.000Z';
const single = (number: number): Release => ({ ...releaseFixture, guid: `synthetic-${number}`, infoHash: null, title: `Synthetic.Show.S02E${String(number).padStart(2, '0')}.1080p` });
const pack: Release = { ...releaseFixture, guid: 'synthetic-pack', infoHash: null, title: 'Synthetic.Show.S02.Complete.1080p' };

function harness(count: number, options: { pack?: Release[]; rejectPack?: boolean; manualPack?: boolean; manualSeason?: number; emptyEpisodes?: boolean; live?: boolean; packQueries?: number; episodeResults?: Release[]; badPlan?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'staged-acquisition-')); directories.push(directory);
  const path = join(directory, 'isolated.db');
  let state = State.open(path); opened.push(state);
  let externalId = 123;
  let unknownQueue = false;
  let unknownLibrary = false;
  let episodes: Episode[] = Array.from({ length: count }, (_, index) => ({ id: 101 + index, seriesId: 1, seasonNumber: 2,
    episodeNumber: index + 1, absoluteEpisodeNumber: null, title: `Episode ${index + 1}`, airDate: '2026-10-01', airDateUtc: '2026-10-01T23:00:00Z', monitored: true, hasFile: false }));
  const stages: Array<{ stage: string | null; numbers: number[] }> = [];
  const queries: string[] = [];
  const grabs: string[] = [];
  let stage: string | null = null;
  let queryFailure: ((query: string) => Error | null) | null = null;
  let onSearch: (() => void) | null = null;
  const llm: LLMClient = { async json<T>(args: { schema: z.ZodType<T>; label: string; user: string }): Promise<T> {
    const data = JSON.parse(args.user);
    if (args.label.startsWith('planner:')) {
      stage = data.searchStage ?? null;
      const numbers = data.targets.flatMap((target: { expectedTargets: Array<{ episodeNumber: number }> }) => target.expectedTargets.map((episode) => episode.episodeNumber));
      stages.push({ stage, numbers });
      const queries = stage === 'episodes'
        ? data.targets.flatMap((target: { targetIndex: number; expectedTargets: Array<{ episodeIndex: number; episodeNumber: number }> }) => target.expectedTargets.map((episode) => ({
          query: `episode-${episode.episodeNumber}`, categories: [5000], targetIndices: [target.targetIndex],
          episodeTargets: [{ targetIndex: target.targetIndex, episodeIndices: [options.badPlan ? 99 : episode.episodeIndex] }],
        })))
        : Array.from({ length: options.packQueries ?? 1 }, (_, index) => ({ query: `pack-${index}`, categories: [5000], targetIndices: data.dueTargetIndices }));
      return args.schema.parse({ queries });
    }
    const manual = options.manualPack && stage === 'pack-batch';
    const skip = options.rejectPack && stage === 'pack-batch';
    const limit = data.selectionLimit ?? 3;
    return args.schema.parse({ selection: { verdict: manual ? 'manual' : skip ? 'skip' : 'grab',
      releaseIndices: manual || skip ? [] : data.candidates.slice(0, limit).map((_: unknown, index: number) => index),
      manualTargetIndices: manual ? data.dueTargetIndices : stage === 'pack-batch'
        ? data.targets.flatMap((target: { seasonNumber: number }, index: number) => target.seasonNumber === options.manualSeason ? [index] : []) : [],
      deferredTargetIndices: [], reason: 'Synthetic stage choice' } });
  } };
  const runner = () => new Runner({ state, logger: pino({ enabled: false }), now: () => new Date(at),
    watcher: { getSnapshot: async () => ({ observedAt: at, sonarr: unknownLibrary ? { known: false, series: [] } : { known: true, series: [{ known: true, series: { id: 1, tvdbId: externalId, title: 'Synthetic Show', titleSlug: 'synthetic', monitored: true, seriesType: 'standard', seasons: [], alternateTitles: [] }, episodes }] }, radarr: { known: true, movies: [] } }) },
    sonarr: { getQueue: async () => { if (unknownQueue) throw new Error('synthetic incomplete queue'); return []; } }, radarr: { getQueue: async () => [] },
    planner: new Planner({ llm }), picker: new Picker({ llm }),
    prowlarr: { getDownloadClients: async () => [{ id: 1, name: 'tv' }], getIndexers: async () => [{ id: 5, enable: true }], getIndexerStatuses: async () => [],
      search: async ({ query }: { query: string }) => { queries.push(query); onSearch?.(); const error = queryFailure?.(query); if (error) throw error;
        return query.startsWith('pack') ? options.pack ?? [] : options.episodeResults ?? (options.emptyEpisodes ? [] : [single(Number(query.slice('episode-'.length)))]); },
      grab: async (release: Release) => { grabs.push(release.title); }, },
    config: { dryRun: !options.live, minRetryHours: 6, failureBackoffMin: 5, failureBackoffMaxMin: 60 }, clientNames: { tv: 'tv', movie: 'movie' },
  } as unknown as RunnerDeps);
  return { get state() { return state; }, get runner() { return runner(); }, stages, queries, grabs, get episodes() { return episodes; }, setEpisodes(value: Episode[]) { episodes = value; },
    setExternalId(value: number) { externalId = value; }, setUnknownQueue() { unknownQueue = true; },
    setUnknownLibrary() { unknownLibrary = true; },
    restart() { state.close(); opened.splice(opened.indexOf(state), 1); state = State.open(path); opened.push(state); },
    failQuery(fn: typeof queryFailure) { queryFailure = fn; }, onSearch(fn: () => void) { onSearch = fn; } };
}

describe('bounded staged TV acquisition', () => {
  it('searches a weekly single explicitly without a pack stage', async () => {
    const run = harness(1);
    expect((await run.runner.cycle()).dryRunGrabs).toBe(1);
    expect(run.stages).toEqual([{ stage: 'episodes', numbers: [1] }]);
    expect(run.queries).toEqual(['episode-1']);
  });

  it.each([false, true])('falls back to singles when a pack is absent or rejected (reject=%s)', async (rejectPack) => {
    const run = harness(3, { pack: rejectPack ? [pack] : [], rejectPack });
    expect((await run.runner.cycle()).dryRunGrabs).toBe(3);
    expect(run.stages).toEqual([{ stage: 'pack-batch', numbers: [1, 2, 3] }, { stage: 'episodes', numbers: [1, 2, 3] }]);
    expect(run.queries).toEqual(['pack-0', 'episode-1', 'episode-2', 'episode-3']);
    expect(run.state.listManualReview()).toEqual([]);
  });

  it('does not run fallback after an acceptable full pack or override a manual identity verdict', async () => {
    const full = harness(4, { pack: [pack] });
    expect((await full.runner.cycle()).dryRunGrabs).toBe(1);
    expect(full.queries).toEqual(['pack-0']);
    const manual = harness(4, { pack: [pack], manualPack: true });
    expect((await manual.runner.cycle()).dryRunGrabs).toBe(0);
    expect(manual.queries).toEqual(['pack-0']);
    expect(manual.state.listManualReview()).toMatchObject([{ reason: 'picker-manual' }]);
  });

  it('excludes provisionally selected coverage from fallback and keeps at most three physical acquisitions', async () => {
    const run = harness(4, { pack: [single(1)] });
    expect((await run.runner.cycle()).dryRunGrabs).toBe(3);
    expect(run.stages).toEqual([{ stage: 'pack-batch', numbers: [1, 2, 3, 4] }, { stage: 'episodes', numbers: [2, 3] }]);
    expect(run.queries).not.toContain('episode-1');
    expect(run.state.listEpisodeProgress().find((episode) => episode.episodeId === 104)!.lastSearchAt).toBeNull();
  });

  it('posts all three disjoint primary/fallback choices with exact reservations through successive fresh checks', async () => {
    const run = harness(4, { pack: [single(1)], live: true });
    expect((await run.runner.cycle()).grabbed).toBe(3);
    expect(run.grabs).toEqual([single(1).title, single(2).title, single(3).title]);
    expect(run.state.listGrabIntents().map((intent) => intent.coverage[0]!.episodeIds!).sort((a, b) => a[0]! - b[0]!)).toEqual([[101], [102], [103]]);
    expect(run.state.listEpisodeProgress().find((episode) => episode.episodeId === 104)!.lastSearchAt).toBeNull();
    expect(run.state.getWorkItem('sonarr:1:s2')!.status).toBe('ready');
  });

  it('remaps bounded episode attribution correctly when a whole sibling season is deferred', async () => {
    const run = harness(6, { emptyEpisodes: true });
    run.setEpisodes(run.episodes.map((episode) => episode.id >= 104 ? { ...episode, seasonNumber: 3 } : episode));
    await run.runner.cycle();
    expect(run.queries).toEqual(['pack-0', 'episode-1', 'episode-2', 'episode-3']);
    expect(run.state.getWorkItem('sonarr:1:s3')!.status).toBe('ready');
    run.restart();
    await run.runner.cycle();
    expect(run.queries.slice(4)).toEqual(['pack-0', 'episode-4', 'episode-5', 'episode-6']);
    expect(run.state.listEpisodeProgress('sonarr:1:s3').map((episode) => episode.lastSearchAt)).toEqual([at, at, at]);
  });

  it('does not let fallback override a manual identity decision for a sibling season', async () => {
    const run = harness(4, { pack: [single(1)], manualSeason: 3, live: true });
    run.setEpisodes(run.episodes.map((episode) => episode.id >= 103 ? { ...episode, seasonNumber: 3 } : episode));
    await run.runner.cycle();
    expect(run.queries).toEqual(['pack-0', 'episode-2']);
    expect(run.grabs).toEqual([single(1).title, single(2).title]);
    expect(run.state.listManualReview()).toMatchObject([{ workKey: 'sonarr:1:s3', reason: 'picker-manual' }]);
    expect(run.state.listEpisodeProgress('sonarr:1:s3').every((episode) => episode.lastSearchAt === null)).toBe(true);
  });

  it('bounds passes at six queries, leaves unattempted episodes due, and progresses fairly', async () => {
    const run = harness(6, { emptyEpisodes: true, packQueries: 3 });
    await run.runner.cycle();
    expect(run.queries).toEqual(['pack-0', 'pack-1', 'pack-2', 'episode-1', 'episode-2', 'episode-3']);
    expect(run.state.listEpisodeProgress().map((episode) => episode.lastSearchAt)).toEqual([at, at, at, null, null, null]);
    expect(run.state.getWorkItem('sonarr:1:s2')!.status).toBe('ready');
    run.restart();
    await run.runner.cycle();
    expect(run.queries.slice(6)).toEqual(['pack-0', 'pack-1', 'pack-2', 'episode-4', 'episode-5', 'episode-6']);
    expect(run.state.listManualReview()).toEqual([]);
  });

  it('stops on a fallback rate limit without inventing attempts or submitting provisional choices', async () => {
    const run = harness(5, { live: true });
    run.failQuery((query) => query === 'episode-2' ? new ApiError(429, 'https://synthetic.invalid', '', 900) : null);
    await run.runner.cycle();
    expect(run.queries).toEqual(['pack-0', 'episode-1', 'episode-2']);
    expect(run.grabs).toEqual([]);
    expect(run.state.listEpisodeProgress().map((episode) => episode.lastSearchAt)).toEqual([at, null, null, null, null]);
    expect(run.state.getWorkItem('sonarr:1:s2')).toMatchObject({ status: 'backoff', lastOutcome: 'rate-limited', nextSearchAt: '2026-10-15T23:15:00.000Z' });
  });

  it('does not post an accepted primary choice when fallback is interrupted by a rate limit', async () => {
    const run = harness(5, { pack: [single(1)], live: true });
    run.failQuery((query) => query === 'episode-3' ? new ApiError(429, 'https://synthetic.invalid', '', 900) : null);
    await run.runner.cycle();
    expect(run.queries).toEqual(['pack-0', 'episode-2', 'episode-3']);
    expect(run.grabs).toEqual([]);
    expect(run.state.listGrabIntents()).toEqual([]);
  });

  it('rejects invented episode attribution before paying for an episode query', async () => {
    const run = harness(1, { badPlan: true, live: true });
    await run.runner.cycle();
    expect(run.queries).toEqual([]);
    expect(run.grabs).toEqual([]);
    expect(run.state.listEpisodeProgress()[0]!.lastSearchAt).toBeNull();
  });

  it('rejects fallback releases whose original footprint overlaps the provisional primary choice', async () => {
    const run = harness(4, { pack: [single(1)], episodeResults: [pack], live: true });
    await run.runner.cycle();
    expect(run.grabs).toEqual([single(1).title]);
    expect(run.state.listGrabIntents()).toMatchObject([{ coverage: [{ episodeIds: [101] }] }]);
  });

  it('never unions contradictory same-physical-release claims across stages', async () => {
    const hash = '1111111111111111111111111111111111111111';
    const run = harness(4, { pack: [{ ...single(1), infoHash: hash }], episodeResults: [{ ...single(2), infoHash: hash }], live: true });
    await run.runner.cycle();
    expect(run.grabs).toEqual([single(1).title]);
    expect(run.state.listGrabIntents()).toHaveLength(1);
    expect(run.state.listGrabIntents()[0]!.coverage).toMatchObject([{ episodeIds: [101] }]);
  });

  it('does not widen an in-flight pack capture when another episode becomes eligible during search', async () => {
    const run = harness(4, { pack: [pack], live: true });
    run.setEpisodes(run.episodes.map((episode) => episode.id === 104 ? { ...episode, airDate: '2026-10-22', airDateUtc: '2026-10-22T23:00:00Z' } : episode));
    run.onSearch(() => run.setEpisodes(run.episodes.map((episode) => episode.id === 104 ? { ...episode, airDate: '2026-10-01', airDateUtc: '2026-10-01T23:00:00Z' } : episode)));
    await run.runner.cycle();
    expect(run.grabs).toEqual([pack.title]);
    expect(run.state.listGrabIntents()[0]!.coverage).toMatchObject([{ episodeIds: [101, 102, 103] }]);
  });

  it.each(['import', 'unmonitor', 'identity', 'numbering', 'new-season', 'unknown-queue', 'unknown-library'] as const)('revalidates %s changes before the actual POST', async (change) => {
    const run = harness(1, { live: true });
    run.onSearch(() => {
      if (change === 'import') run.setEpisodes(run.episodes.map((episode) => ({ ...episode, hasFile: true })));
      if (change === 'unmonitor') run.setEpisodes(run.episodes.map((episode) => ({ ...episode, monitored: false })));
      if (change === 'identity') run.setExternalId(999);
      if (change === 'numbering') run.setEpisodes(run.episodes.map((episode) => ({ ...episode, episodeNumber: 99 })));
      if (change === 'new-season') run.setEpisodes([...run.episodes, { ...run.episodes[0]!, id: 301, seasonNumber: 3 }]);
      if (change === 'unknown-queue') run.setUnknownQueue();
      if (change === 'unknown-library') run.setUnknownLibrary();
    });
    await run.runner.cycle();
    expect(run.grabs).toEqual([]);
    expect(run.state.listGrabIntents()).toEqual([]);
  });
});
