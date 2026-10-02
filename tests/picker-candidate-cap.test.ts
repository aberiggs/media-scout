import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { Runner, type RunnerDeps } from '../src/core/runner';
import { State } from '../src/core/state';
import type { GroupCandidate } from '../src/core/group-types';
import type { LibrarySnapshot } from '../src/core/watcher';

const NOW = new Date('2026-09-29T00:00:00.000Z');
const TARGET_KEY = 'radarr:1';

function candidateReleases() {
  return Array.from({ length: 101 }, (_, index) => ({
    guid: `release-${String(index + 1).padStart(3, '0')}`,
    indexerId: 5,
    title: index === 99 ? 'Wanted Film (2024) 1080p BluRay x265' : `Wanted Film (2024) ${index + 1} 720p WEB-DL`,
    infoHash: `CAPCANDIDATE${String(index + 1).padStart(20, '0')}`,
    protocol: 'torrent',
    magnetUrl: `magnet:?xt=urn:btih:${String(index + 1).padStart(40, '0')}`,
    downloadUrl: null,
    seeders: 1000 - index,
    leechers: 0,
    size: 2_000_000_000 + index,
    age: 1,
    ageHours: 1,
    ageMinutes: 60,
    files: 1,
    grabs: 1,
    releaseHash: '',
    sortTitle: '',
    imdbId: null,
    tmdbId: 1001,
    tvdbId: null,
    tvMazeId: null,
    publishDate: '2026-09-01T00:00:00Z',
    commentUrl: null,
    infoUrl: null,
    posterUrl: null,
    indexerFlags: [],
    categories: [],
    indexer: 'test-indexer',
    subGroup: null,
    fileName: null,
    downloadClientId: null,
  }));
}

function snapshot(): LibrarySnapshot {
  const movie = {
    id: 1,
    tmdbId: 1001,
    title: 'Wanted Film',
    titleSlug: 'wanted-film',
    year: 2024,
    monitored: true,
    hasFile: false,
    isAvailable: true,
    sizeOnDisk: 0,
  };
  return {
    observedAt: NOW.toISOString(),
    sonarr: { known: true, series: [] },
    radarr: { known: true, movies: [movie] },
  } as unknown as LibrarySnapshot;
}

function buildRunner(args: { dryRun?: boolean; releases: ReturnType<typeof candidateReleases>; onGroupCandidates?: (candidates: GroupCandidate[]) => void }) {
  const state = State.open(':memory:');
  const prowlarr = {
    getDownloadClients: vi.fn(async () => [{ id: 2, name: 'qBit-Movies' }]),
    getIndexers: vi.fn(async () => [{ id: 5, enable: true }]),
    getIndexerStatuses: vi.fn(async () => []),
    search: vi.fn(async () => args.releases),
    grab: vi.fn(async () => undefined),
  };
  const planner = {
    planGroup: vi.fn(async ({ group }: { group: { dueTargetIndices: number[] } }) => [{
      query: 'Wanted Film 2024', categories: [2000], targetIndices: group.dueTargetIndices,
    }]),
    plan: vi.fn(async () => [{ query: 'Wanted Film 2024', categories: [2000] }]),
  };
  const picker = {
    pickGroup: vi.fn(async ({ candidates }: { candidates: GroupCandidate[] }) => {
      args.onGroupCandidates?.(candidates);
      return { verdict: 'skip' as const, releaseIndices: [], manualTargetIndices: [], deferredTargetIndices: [], reason: 'fixture boundary observation' };
    }),
  };
  const loggerMock = { child: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  loggerMock.child.mockReturnValue(loggerMock);
  const deps: RunnerDeps = {
    watcher: { getSnapshot: vi.fn(async () => snapshot()) } as never,
    planner: planner as never,
    picker: picker as never,
    prowlarr: prowlarr as never,
    sonarr: { getQueue: vi.fn(async () => []) } as never,
    radarr: { getQueue: vi.fn(async () => []) } as never,
    state,
    config: { dryRun: args.dryRun ?? false, minRetryHours: 6, failureBackoffMin: 5, failureBackoffMaxMin: 60 },
    clientNames: { tv: 'qBit-TV', movie: 'qBit-Movies' },
    logger: loggerMock as unknown as Logger,
    now: () => NOW,
  };
  return { runner: new Runner(deps), state, planner, picker, prowlarr };
}

describe('runner picker candidate cap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes the top 100 unique admitted candidates, including the rank-100 release, and omits rank 101', async () => {
    const releases = candidateReleases();
    let presented: GroupCandidate[] = [];
    const stack = buildRunner({ dryRun: false, releases, onGroupCandidates: (candidates) => { presented = candidates; } });

    const summary = await stack.runner.cycle();

    expect(stack.picker.pickGroup).toHaveBeenCalledTimes(1);
    expect(presented).toHaveLength(100);
    expect(presented.map((candidate) => candidate.release.guid)).toHaveLength(100);
    expect(new Set(presented.map((candidate) => candidate.release.guid)).size).toBe(100);
    expect(new Set(presented.map((candidate) => candidate.release.infoHash)).size).toBe(100);
    expect(presented[99]?.release).toMatchObject({ guid: 'release-100', title: 'Wanted Film (2024) 1080p BluRay x265', seeders: 901 });
    expect(presented.some((candidate) => candidate.release.guid === 'release-101')).toBe(false);
    expect(summary.searched).toBe(1);
    expect(summary.grabbed).toBe(0);
    expect(stack.prowlarr.grab).not.toHaveBeenCalled();
    expect(stack.state.listGrabIntents()).toEqual([]);
  });

  it('uses the same 100-item bound for each fresh manual-pick list and preserves its 0-based index contract', async () => {
    const releases = candidateReleases();
    const stack = buildRunner({ dryRun: true, releases });

    const boundary = await stack.runner.manualPick(TARGET_KEY, 99);
    expect(boundary.releaseTitle).toBe('Wanted Film (2024) 1080p BluRay x265');
    expect(boundary.outcome).toBe('dry-run');
    expect(stack.prowlarr.grab).not.toHaveBeenCalled();
    await expect(stack.runner.manualPick(TARGET_KEY, 100)).rejects.toThrow(/releaseIndex 100 out of range \(0\.\.99\)/);
    expect(stack.prowlarr.grab).not.toHaveBeenCalled();
  });
});
