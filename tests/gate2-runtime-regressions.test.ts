import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { ZodType } from 'zod';
import type { Logger } from 'pino';
import type { LLMClient } from '../src/clients/llm';
import { Planner } from '../src/core/planner';
import { Picker } from '../src/core/picker';
import { Runner, type RunnerDeps } from '../src/core/runner';
import { State } from '../src/core/state';
import type { LibrarySnapshot, Watcher } from '../src/core/watcher';
import type { SonarrQueueRecord } from '../src/types/sonarr';
import type { Release } from '../src/types/prowlarr';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const releaseFixture = JSON.parse(readFileSync(new URL('./fixtures/prowlarr-release.json', import.meta.url), 'utf8')) as Release;

function regressionSnapshot(snapshotEpisodes?: LibrarySnapshot['sonarr']['series'][number]['episodes']): LibrarySnapshot {
  const series = {
    id: 31, tvdbId: 310, title: 'Alpha', titleSlug: 'alpha', seriesType: 'standard', monitored: true,
    seasons: [], alternateTitles: [],
  } as LibrarySnapshot['sonarr']['series'][number]['series'];
  return {
    observedAt: NOW.toISOString(),
    sonarr: { known: true, series: [{ series, known: true, episodes: [
      ...(snapshotEpisodes ?? [
        { id: 3101, seriesId: 31, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'One', airDate: '2020-01-01', monitored: true, hasFile: false },
        { id: 3201, seriesId: 31, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Two', airDate: '2020-01-01', monitored: true, hasFile: true },
      ]),
    ] }] },
    radarr: { known: true, movies: [] },
  };
}

class ScriptedGroupLLM implements LLMClient {
  constructor(private readonly onPick: () => void, private readonly releaseIndices: number[] = [0]) {}
  async json<T>(args: { system: string; user: string; schema: ZodType<T>; label: string }): Promise<T> {
    if (args.label.startsWith('planner:group:')) {
      return args.schema.parse({ queries: [{ query: 'Alpha', categories: [5000], targetIndices: [0] }] }) as T;
    }
    if (args.label.startsWith('picker:group:')) {
      this.onPick();
      return args.schema.parse({ selection: { verdict: 'grab', releaseIndices: this.releaseIndices, manualTargetIndices: [], deferredTargetIndices: [], reason: 'test selection' } }) as T;
    }
    throw new Error(`Unexpected LLM call: ${args.label}`);
  }
}

function logger(): Logger {
  return { warn() {}, info() {}, debug() {}, error() {}, child() { return this; } } as unknown as Logger;
}

function makeRuntime(options: {
  latestQueue?: SonarrQueueRecord[];
  initialQueue?: SonarrQueueRecord[];
  latestQueueUnknown?: boolean;
  releaseTitle: string;
  releaseTitles?: string[];
  releaseIndices?: number[];
  snapshotEpisodes?: LibrarySnapshot['sonarr']['series'][number]['episodes'];
}) {
  const state = new State(new Database(':memory:'));
  let sonarrReads = 0;
  let grabs = 0;
  let pickerCalls = 0;
  const grabbedGuids: string[] = [];
  const snapshotEpisodes = options.snapshotEpisodes;
  const snapshot = regressionSnapshot(snapshotEpisodes);
  const sonarr = {
    async getQueue() {
      const read = sonarrReads++;
      if (read >= 2 && options.latestQueueUnknown) throw new Error('synthetic incomplete queue read');
      return read >= 2 ? options.latestQueue ?? [] : options.initialQueue ?? [];
    },
  };
  // The picker callback is the race point: the third queue read is the fresh
  // immediate-pre-reservation observation after this model selection.
  const racingLlm = new ScriptedGroupLLM(() => {
    if (sonarrReads < 2) throw new Error('picker ran before candidate admission');
    pickerCalls += 1;
  }, options.releaseIndices);
  const prowlarr = {
    async getIndexers() { return [{ id: 5, enable: true }]; },
    async getIndexerStatuses() { return []; },
    async getDownloadClients() { return [{ id: 1, name: 'qBit-TV' }, { id: 2, name: 'qBit-Movies' }]; },
    async search() { return (options.releaseTitles ?? [options.releaseTitle]).map((title, index) => ({ ...releaseFixture, title, guid: `gate2-release-${index}`, infoHash: `GATE2PHYSICAL${index}` })); },
    async grab(value: { guid: string }) { grabs += 1; grabbedGuids.push(value.guid); },
  };
  const runner = new Runner({
    watcher: { async getSnapshot() { return snapshot; } } as Watcher,
    sonarr,
    radarr: { async getQueue() { return []; } },
    planner: new Planner({ llm: racingLlm }),
    picker: new Picker({ llm: racingLlm }),
    prowlarr: prowlarr as unknown as RunnerDeps['prowlarr'],
    state,
    config: { dryRun: false, minRetryHours: 6 },
    clientNames: { tv: 'qBit-TV', movie: 'qBit-Movies' },
    logger: logger(),
    now: () => new Date(NOW),
  });
  return { runner, state, grabs: () => grabs, pickerCalls: () => pickerCalls, grabbedGuids };
}

describe('Gate2 fresh physical-scope runtime regressions', () => {
  it('rejects a selected extra-season pack when a fresh authoritative queue row claims that extra season', async () => {
    const runtime = makeRuntime({
      releaseTitle: 'Alpha S01E01 S02E01 1080p',
      latestQueue: [{ id: 90, downloadId: 'fresh-season-two', seriesId: 31, episodeId: 3201, seasonNumber: 2, status: 'downloading', trackedDownloadState: 'downloading' } as SonarrQueueRecord],
    });

    const summary = await runtime.runner.cycle();

    expect(summary.grabbed).toBe(0);
    expect(runtime.grabs()).toBe(0);
    expect(runtime.state.listGrabIntents()).toHaveLength(0);
  });

  it('rejects whole-series scope against a fresh extra-season hold but allows a disjoint extra-season pack', async () => {
    const wholeSeries = makeRuntime({
      releaseTitle: 'Alpha Complete Series 1080p',
      latestQueue: [{ id: 91, downloadId: 'fresh-season-two', seriesId: 31, episodeId: 3201, seasonNumber: 2, status: 'downloading' } as SonarrQueueRecord],
    });
    const wholeSummary = await wholeSeries.runner.cycle();
    expect(wholeSummary.grabbed).toBe(0);
    expect(wholeSeries.grabs()).toBe(0);
    expect(wholeSeries.state.listGrabIntents()).toHaveLength(0);

    const disjoint = makeRuntime({
      releaseTitle: 'Alpha S01E01 S02E01 1080p',
      latestQueue: [{ id: 92, downloadId: 'fresh-season-three', seriesId: 31, episodeId: 3301, seasonNumber: 3, status: 'downloading' } as SonarrQueueRecord],
      snapshotEpisodes: [
        { id: 3101, seriesId: 31, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'One', airDate: '2020-01-01', monitored: true, hasFile: false },
        { id: 3201, seriesId: 31, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Two', airDate: '2020-01-01', monitored: true, hasFile: true },
        { id: 3301, seriesId: 31, seasonNumber: 3, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Three', airDate: '2020-01-01', monitored: true, hasFile: true },
      ],
    });
    const disjointSummary = await disjoint.runner.cycle();
    expect(disjointSummary.grabbed).toBe(1);
    expect(disjoint.grabs()).toBe(1);
    expect(disjoint.state.listGrabIntents()).toHaveLength(1);
  });

  const contradictoryScopes = [
    ['season', { id: 95, downloadId: 'wrong-season', seriesId: 31, episodeId: 3201, seasonNumber: 3, status: 'downloading' }],
    ['series', { id: 96, downloadId: 'wrong-series', seriesId: 2, episodeId: 3201, seasonNumber: 2, status: 'downloading' }],
  ] as const;

  it.each(contradictoryScopes)(
    'rejects a raw-versus-episode %s scope contradiction during initial admission',
    async (_kind, record) => {
      const runtime = makeRuntime({
        releaseTitle: 'Alpha S01E01 S02E01 1080p',
        initialQueue: [record as SonarrQueueRecord],
      });

      const summary = await runtime.runner.cycle();

      expect(summary.grabbed).toBe(0);
      expect(runtime.pickerCalls()).toBe(0);
      expect(runtime.grabs()).toBe(0);
      expect(runtime.state.listGrabIntents()).toHaveLength(0);
    },
  );

  it.each(contradictoryScopes)(
    'rejects a raw-versus-episode %s scope contradiction introduced before reservation',
    async (_kind, record) => {
      const runtime = makeRuntime({
        releaseTitle: 'Alpha S01E01 S02E01 1080p',
        latestQueue: [record as SonarrQueueRecord],
      });

      const summary = await runtime.runner.cycle();

      expect(summary.grabbed).toBe(0);
      expect(runtime.pickerCalls()).toBe(1);
      expect(runtime.grabs()).toBe(0);
      expect(runtime.state.listGrabIntents()).toHaveLength(0);
    },
  );

  it('keeps a failed fresh queue read unknown and does not reserve or grab', async () => {
    const runtime = makeRuntime({ releaseTitle: 'Alpha S01E01 S02E01 1080p', latestQueueUnknown: true });

    const summary = await runtime.runner.cycle();

    expect(summary.grabbed).toBe(0);
    expect(runtime.grabs()).toBe(0);
    expect(runtime.state.listGrabIntents()).toHaveLength(0);
  });

  it('treats a matching but unscoped future queue state as a conservative physical-scope conflict', async () => {
    const runtime = makeRuntime({
      releaseTitle: 'Alpha S01E01 S02E01 1080p',
      latestQueue: [{ id: 94, downloadId: 'unscoped-job', seriesId: 31, status: 'future-arr-state' } as SonarrQueueRecord],
    });

    const summary = await runtime.runner.cycle();

    expect(summary.grabbed).toBe(0);
    expect(runtime.grabs()).toBe(0);
    expect(runtime.state.listGrabIntents()).toHaveLength(0);
  });

  it('reserves and posts two exact disjoint explicit episodes selected from one grouped search', async () => {
    const runtime = makeRuntime({
      releaseTitle: 'unused',
      releaseTitles: ['Alpha S01E01 1080p', 'Alpha S01E02 1080p'],
      releaseIndices: [0, 1],
      snapshotEpisodes: [
        { id: 3101, seriesId: 31, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'One', airDate: '2020-01-01', monitored: true, hasFile: false },
        { id: 3102, seriesId: 31, seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: null, title: 'Two', airDate: '2020-01-08', monitored: true, hasFile: false },
      ],
    });

    const summary = await runtime.runner.cycle();
    const intents = runtime.state.listGrabIntents();

    expect(summary.grabbed).toBe(2);
    expect(runtime.grabs()).toBe(2);
    expect(intents).toHaveLength(2);
    expect(intents.map((intent) => intent.coverage).sort((left, right) => (left[0]?.episodeIds?.[0] ?? 0) - (right[0]?.episodeIds?.[0] ?? 0))).toEqual([
      [{ workKey: 'sonarr:31:s1', episodeIds: [3101], basis: 'explicit-episodes' }],
      [{ workKey: 'sonarr:31:s1', episodeIds: [3102], basis: 'explicit-episodes' }],
    ]);
    expect(new Set(intents.map((intent) => intent.guid)).size).toBe(2);
    expect(intents.every((intent) => runtime.state.hasRelease(intent.indexerId, intent.guid))).toBe(true);
    expect(new Set(intents.map((intent) => intent.infoHash))).toEqual(new Set(['GATE2PHYSICAL0', 'GATE2PHYSICAL1']));
    expect(new Set(runtime.grabbedGuids)).toEqual(new Set(['gate2-release-0', 'gate2-release-1']));
  });

  it('allows only the exact residual episode when a preexisting active queue item holds another episode', async () => {
    const activeEpisodeOne = { id: 93, downloadId: 'preexisting-e1', seriesId: 31, episodeId: 3101, seasonNumber: 1, status: 'downloading', trackedDownloadState: 'downloading' } as SonarrQueueRecord;
    const runtime = makeRuntime({
      releaseTitle: 'Alpha S01E02 1080p',
      initialQueue: [activeEpisodeOne],
      latestQueue: [activeEpisodeOne],
      snapshotEpisodes: [
        { id: 3101, seriesId: 31, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'One', airDate: '2020-01-01', monitored: true, hasFile: false },
        { id: 3102, seriesId: 31, seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: null, title: 'Two', airDate: '2020-01-08', monitored: true, hasFile: false },
      ],
    });

    const summary = await runtime.runner.cycle();
    const intents = runtime.state.listGrabIntents();

    expect(summary.grabbed).toBe(1);
    expect(runtime.grabs()).toBe(1);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.coverage).toEqual([{ workKey: 'sonarr:31:s1', episodeIds: [3102], basis: 'explicit-episodes' }]);
  });
});
