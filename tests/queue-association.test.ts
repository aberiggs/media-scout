import { describe, expect, it } from 'vitest';
import { QueueAssociator, buildAssociationRequests } from '../src/core/queue-association';
import type { AssociationCacheEntry, AssociationRequest } from '../src/core/group-types';
import { reconcileWork, type QueueReads } from '../src/core/work-queue';
import type { LibrarySnapshot } from '../src/core/watcher';
import type { LLMClient } from '../src/clients/llm';

class FakeLLM implements LLMClient {
  readonly calls: Array<{ system: string; user: string }> = [];
  constructor(private readonly replies: unknown[]) {}

  async json<T>(args: Parameters<LLMClient['json']>[0]): Promise<T> {
    this.calls.push({ system: args.system, user: args.user });
    return args.schema.parse(this.replies.shift()) as T;
  }
}

const snapshot: LibrarySnapshot = {
  observedAt: '2026-10-01T10:00:00.000Z',
  sonarr: {
    known: true,
    series: [{
      known: true,
      series: {
        id: 11, tvdbId: 111, title: 'The Example', titleSlug: 'the-example', seriesType: 'standard', monitored: true,
        seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 0, totalEpisodeCount: 2 } }],
        alternateTitles: [{ title: 'Example Show' }],
      },
      episodes: [
        { id: 101, seriesId: 11, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'One', airDate: '2020-01-01', monitored: true, hasFile: false },
        { id: 102, seriesId: 11, seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: null, title: 'Two', airDate: '2020-01-08', monitored: true, hasFile: false },
      ],
    }],
  },
  radarr: { known: true, movies: [] },
};

function queueReads(records: Array<{
  id?: number | null; downloadId?: string | null; title?: string | null; status?: string | null;
  sizeleft?: number | null;
  trackedDownloadStatus?: string | null; trackedDownloadState?: string | null;
  seriesId?: number | null; episodeId?: number | null; seasonNumber?: number | null;
}>): QueueReads {
  return {
    sonarr: { kind: 'known', observedAt: '2026-10-01T10:00:00.000Z', records },
    radarr: { kind: 'known', observedAt: '2026-10-01T10:00:00.000Z', records: [] },
  };
}

function request(records = queueReads([{ id: 7, title: 'Example Show S01E01', status: 'downloading' }])): AssociationRequest {
  const built = buildAssociationRequests({ snapshot, queues: records, cache: [] });
  expect(built.length).toBeGreaterThan(0);
  return built[0]!;
}

describe('queue association preparation and validation', () => {
  it('lets the model match an alias to supplied references and derives only parser-supported episode IDs', async () => {
    const req = request(queueReads([{ id: 7, downloadId: 'private-download-token', title: 'Example Show S01E01 https://private.example/path?apikey=secret /Users/secret/source.mkv aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'downloading' }]));
    expect(req.media[0]!.title).toContain('Example Show');
    const llm = new FakeLLM([{ decisions: [{ queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'Alias and S01E01 agree.' }] }]);
    const decisions = await new QueueAssociator({ llm }).associate(req);
    expect(decisions).toEqual([expect.objectContaining({
      arr: 'sonarr', queueRef: 'download:private-download-token', outcome: 'matched',
      mediaReferences: [{ arr: 'sonarr', serviceId: 11, externalId: 111 }],
      workReferences: [expect.objectContaining({ workKey: 'sonarr:11:s1', seasonNumber: 1 })],
      potentialScope: 'episodes', seasonNumber: 1, episodeIds: [101], basis: 'explicit-episodes',
    })]);
    expect(llm.calls[0]!.user).toContain('Example Show S01E01');
    expect(llm.calls[0]!.user).toContain('Example Show'); // supplied Sonarr alias reaches the model as media identity evidence.
    for (const secret of ['row:7', 'private-download-token', 'private.example', 'apikey=secret', '/Users/secret', 'source.mkv', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sourceJobKey', 'materialSignature', 'queueRefsByIndex', 'episodeId":101']) {
      expect(llm.calls[0]!.user).not.toContain(secret);
    }
  });

  it('rejects invalid, duplicate, omitted, and out-of-scope provider indices as a whole', async () => {
    const reqs = buildAssociationRequests({ snapshot, queues: queueReads([
      { id: 7, title: 'Example Show S01E01' },
      { id: 8, title: 'Other Show' },
    ]), cache: [] });
    const base = reqs[0]!;
    const req: AssociationRequest = {
      ...base,
      queue: [base.queue[0]!, { ...base.queue[0]!, queueIndex: 1 }],
      lookup: { ...base.lookup, queueRefsByIndex: ['row:7', 'row:8'] },
    };
    const invalid = new QueueAssociator({ llm: new FakeLLM([{ decisions: [
      { queueIndex: 0, outcome: 'matched', mediaIndices: [100], targetIndices: [0], reason: 'bad media' },
      { queueIndex: 1, outcome: 'unrelated', mediaIndices: [], targetIndices: [], reason: 'other' },
    ] }]) });
    await expect(invalid.associate(req)).rejects.toThrow();
    const omitted = new QueueAssociator({ llm: new FakeLLM([{ decisions: [
      { queueIndex: 0, outcome: 'unrelated', mediaIndices: [], targetIndices: [], reason: 'other' },
    ] }]) });
    await expect(omitted.associate(req)).rejects.toThrow();
    const duplicate = new QueueAssociator({ llm: new FakeLLM([{ decisions: [
      { queueIndex: 0, outcome: 'unrelated', mediaIndices: [], targetIndices: [], reason: 'one' },
      { queueIndex: 0, outcome: 'unrelated', mediaIndices: [], targetIndices: [], reason: 'two' },
      { queueIndex: 1, outcome: 'unrelated', mediaIndices: [], targetIndices: [], reason: 'other' },
    ] }]) });
    await expect(duplicate.associate(req)).rejects.toThrow();
    const wrongSource: AssociationRequest = {
      ...reqs[0]!,
      lookup: { ...reqs[0]!.lookup, mediaReferencesByIndex: [{ ...reqs[0]!.lookup.mediaReferencesByIndex[0]!, arr: 'radarr' }] },
    };
    await expect(new QueueAssociator({ llm: new FakeLLM([]) }).associate(wrongSource)).rejects.toThrow();
  });

  it('does not ask the model to override authoritative complete episode associations', () => {
    const reqs = buildAssociationRequests({ snapshot, queues: queueReads([
      { id: 7, title: 'Example Show S01E01', seriesId: 11, episodeId: 101, seasonNumber: 1 },
    ]), cache: [] });
    expect(reqs).toEqual([]);
  });

  it('keeps broad plain titles at series scope and explicit matching season claims scoped without inventing coverage', async () => {
    const broadReq = request(queueReads([{ id: 7, title: 'The Example' }]));
    const broad = await new QueueAssociator({ llm: new FakeLLM([{ decisions: [
      { queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'Likely same series.' },
    ] }]) }).associate(broadReq);
    expect(broad[0]).toMatchObject({ potentialScope: 'series', seasonNumber: null, episodeIds: null, basis: null });

    const seasonReq = request(queueReads([{ id: 9, title: 'The Example S01' }]));
    const season = await new QueueAssociator({ llm: new FakeLLM([{ decisions: [
      { queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'Matching season pack.' },
    ] }]) }).associate(seasonReq);
    expect(season[0]).toMatchObject({ potentialScope: 'season', seasonNumber: 1, episodeIds: null, basis: 'inferred-season-pack' });

    const wholeReq = request(queueReads([{ id: 10, title: 'The Example Complete Series' }]));
    const whole = await new QueueAssociator({ llm: new FakeLLM([{ decisions: [
      { queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'Explicit whole series claim.' },
    ] }]) }).associate(wholeReq);
    expect(whole[0]).toMatchObject({ potentialScope: 'series', episodeIds: null, basis: null });
  });

  it('an unrelated result never carries fabricated media or coverage', async () => {
    const llm = new FakeLLM([{ decisions: [{ queueIndex: 0, outcome: 'unrelated', mediaIndices: [], targetIndices: [], reason: 'Different title.' }] }]);
    const [decision] = await new QueueAssociator({ llm }).associate(request());
    expect(decision).toMatchObject({ outcome: 'unrelated', mediaReferences: [], workReferences: [], potentialScope: 'unknown', episodeIds: null, basis: null });
    const [uncertain] = await new QueueAssociator({ llm: new FakeLLM([{ decisions: [
      { queueIndex: 0, outcome: 'uncertain', mediaIndices: [], targetIndices: [], reason: 'Title is too short.' },
    ] }]) }).associate(request());
    expect(uncertain).toMatchObject({ outcome: 'uncertain', mediaReferences: [], workReferences: [], potentialScope: 'unknown', episodeIds: null, basis: null });
  });

  it('does not persist proof without stable identity and conservatively holds all scope-conflicting rows for one physical job', async () => {
    const noId = buildAssociationRequests({ snapshot, queues: queueReads([{ title: 'The Example S01E01' }]), cache: [] });
    expect(noId).toEqual([]);

    const multiSeasonSnapshot: LibrarySnapshot = {
      ...snapshot,
      sonarr: {
        ...snapshot.sonarr,
        series: [{
          ...snapshot.sonarr.series[0]!,
          series: { ...snapshot.sonarr.series[0]!.series, seasons: [
            { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 0, totalEpisodeCount: 2 } },
            { seasonNumber: 2, monitored: true, statistics: { episodeFileCount: 0, totalEpisodeCount: 1 } },
          ] },
          episodes: [
            ...snapshot.sonarr.series[0]!.episodes!,
            { id: 201, seriesId: 11, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Three', airDate: '2020-02-01', monitored: true, hasFile: false },
          ],
        }],
      },
    };
    const rows = queueReads([
      { id: 7, downloadId: 'private-download-token', title: 'The Example S01E01', seriesId: 11, seasonNumber: 1 },
      { id: 8, downloadId: 'private-download-token', title: 'The Example S01E02', seriesId: 11, seasonNumber: 1 },
    ]);
    const grouped = buildAssociationRequests({ snapshot: multiSeasonSnapshot, queues: rows, cache: [] });
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.queue).toHaveLength(1);
    expect(grouped[0]!.lookup.queueRefsByIndex).toEqual(['download:private-download-token']);
    expect(grouped[0]!.targets).toHaveLength(1);
    expect(grouped[0]!.queue[0]!.title).toBe('The Example S01E01');
    const [decision] = await new QueueAssociator({ llm: new FakeLLM([{ decisions: [
      { queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'Series identity only.' },
    ] }]) }).associate(grouped[0]!);
    expect(decision).toMatchObject({
      outcome: 'matched', mediaReferences: [{ arr: 'sonarr', serviceId: 11, externalId: 111 }],
      workReferences: [
        { workKey: 'sonarr:11:s1', seasonNumber: 1 },
      ],
      potentialScope: 'unknown', seasonNumber: null, episodeIds: null, basis: null,
      uncertainty: expect.any(String),
    });
    const reconciled = reconcileWork({
      snapshot: multiSeasonSnapshot, queues: rows, existingWorkItems: [], intents: [], now: '2026-10-01T10:00:00.000Z',
      minRetryHours: 6, queueGraceMin: 30, associationDecisions: [decision!],
    });
    expect(reconciled.items.map(({ work, eligibleUnit, queueCoverage, activeCoverage, blockedReason }) => ({
      key: work.workKey, residual: eligibleUnit?.season?.missing.map(({ episodeId }) => episodeId) ?? [],
      queueCoverage, activeCoverage, blockedReason,
    }))).toEqual([
      { key: 'sonarr:11:s1', residual: [], queueCoverage: [], activeCoverage: [], blockedReason: 'queue-ambiguous' },
      { key: 'sonarr:11:s2', residual: [], queueCoverage: [], activeCoverage: [], blockedReason: 'queue-ambiguous' },
    ]);
  });

  it('densely reindexes filtered media and later-season targets before exposing request-local indices', async () => {
    const expandedSnapshot: LibrarySnapshot = {
      ...snapshot,
      sonarr: {
        ...snapshot.sonarr,
        series: [
          ...snapshot.sonarr.series,
          {
            known: true,
            series: {
              id: 22, tvdbId: 222, title: 'Second Example', titleSlug: 'second-example', seriesType: 'standard', monitored: true,
              seasons: [
                { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 0, totalEpisodeCount: 1 } },
                { seasonNumber: 2, monitored: true, statistics: { episodeFileCount: 0, totalEpisodeCount: 1 } },
              ], alternateTitles: [],
            },
            episodes: [
              { id: 301, seriesId: 22, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'First', airDate: '2020-01-01', monitored: true, hasFile: false },
              { id: 302, seriesId: 22, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Later', airDate: '2020-02-01', monitored: true, hasFile: false },
            ],
          },
        ],
      },
    };
    const built = buildAssociationRequests({
      snapshot: expandedSnapshot,
      queues: queueReads([{ id: 9, title: 'Second Example S02E01', seriesId: 22, seasonNumber: 2 }]),
      cache: [],
    });
    expect(built).toHaveLength(1);
    const req = built[0]!;
    expect(req.media.map(({ mediaIndex }) => mediaIndex)).toEqual([0]);
    expect(req.targets.map(({ targetIndex }) => targetIndex)).toEqual([0]);
    expect(req.lookup.mediaReferencesByIndex).toEqual([{ arr: 'sonarr', serviceId: 22, externalId: 222 }]);
    expect(req.lookup.workReferencesByIndex).toEqual([{
      workKey: 'sonarr:22:s2', arr: 'sonarr', serviceId: 22, externalId: 222, seasonNumber: 2,
    }]);
    const llm = new FakeLLM([{ decisions: [
      { queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'Later-season association.' },
    ] }]);
    const [decision] = await new QueueAssociator({ llm }).associate(req);
    const displayed = JSON.parse(llm.calls[0]!.user) as {
      media: Array<{ mediaIndex: number }>;
      targets: Array<{ targetIndex: number; seasonNumber: number }>;
    };
    expect(displayed.media.map(({ mediaIndex }) => mediaIndex)).toEqual([0]);
    expect(displayed.targets.map(({ targetIndex, seasonNumber }) => [targetIndex, seasonNumber])).toEqual([[0, 2]]);
    expect(decision).toMatchObject({
      mediaReferences: [{ serviceId: 22, externalId: 222 }],
      workReferences: [{ workKey: 'sonarr:22:s2', serviceId: 22, seasonNumber: 2 }],
      potentialScope: 'episodes', seasonNumber: 2, episodeIds: [302],
    });
  });

  it('does not infer media or season authority from an episode ID absent from the known library map', async () => {
    const requests = buildAssociationRequests({ snapshot, queues: queueReads([
      { id: 12, title: 'The Example', episodeId: 999 },
    ]), cache: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.media).toHaveLength(1);
    expect(requests[0]!.targets).toHaveLength(1);
    expect(requests[0]!.lookup.workReferencesByIndex[0]!.seasonNumber).toBe(1);
    expect(requests[0]!.queue[0]!.title).toBe('The Example');
    const [decision] = await new QueueAssociator({ llm: new FakeLLM([{ decisions: [
      { queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'Series identity only.' },
    ] }]) }).associate(requests[0]!);
    expect(decision).toMatchObject({ potentialScope: 'series', seasonNumber: null, episodeIds: null, basis: null });
  });

  it('keeps material cache stable across progress, status, timestamp, and row ordering, but invalidates identity/target changes', () => {
    const first = buildAssociationRequests({ snapshot, queues: queueReads([
      { id: 7, downloadId: 'd7', title: 'The Example S01E01', status: 'downloading', sizeleft: 900 },
      { id: 8, downloadId: 'd8', title: 'Other title', status: 'queued' },
    ]), cache: [] });
    const cache: AssociationCacheEntry[] = first.map((item) => ({
      arr: item.arr, sourceJobKey: item.sourceJobKey, materialSignature: item.materialSignature,
      contextSignature: item.contextSignature, promptVersion: item.promptVersion, cachedAt: 'then',
      decisions: [{ arr: item.arr, queueRef: item.lookup.queueRefsByIndex[0]!, outcome: 'uncertain', mediaReferences: [], workReferences: [], potentialScope: 'unknown', seasonNumber: null, episodeIds: null, basis: null, uncertainty: 'not enough identity' }],
    }));
    const stable = buildAssociationRequests({ snapshot: { ...snapshot, observedAt: 'later' }, queues: queueReads([
      { id: 8, downloadId: 'd8', title: 'Other title', status: 'completed' },
      { id: 7, downloadId: 'd7', title: 'The Example S01E01', status: 'paused', sizeleft: 1 },
    ]), cache });
    expect(stable).toEqual([]);
    expect(buildAssociationRequests({ snapshot, queues: queueReads([
      { id: 7, downloadId: 'd7', title: 'The Example S01E02' }, { id: 8, downloadId: 'd8', title: 'Other title' },
    ]), cache })).not.toEqual([]);
    const changedTarget: LibrarySnapshot = {
      ...snapshot,
      sonarr: { ...snapshot.sonarr, series: snapshot.sonarr.series.map((observation) => ({
        ...observation,
        known: observation.known && observation.episodes !== null,
        episodes: observation.episodes?.map((episode) => episode.id === 102 ? { ...episode, title: 'Changed expected description' } : episode) ?? null,
      })) },
    };
    expect(buildAssociationRequests({ snapshot: changedTarget, queues: queueReads([
      { id: 7, downloadId: 'd7', title: 'The Example S01E01' }, { id: 8, downloadId: 'd8', title: 'Other title' },
    ]), cache })).not.toEqual([]);
    expect(buildAssociationRequests({ snapshot, queues: queueReads([
      { id: 7, downloadId: 'd7', title: 'The Example S01E01' },
    ]), cache, promptVersion: 'new-prompt' })).not.toEqual([]);
  });

  it('does not issue requests when either source observation is unknown', () => {
    const queues: QueueReads = {
      sonarr: { kind: 'unknown', observedAt: 'now', errorCode: 'read-failed' },
      radarr: { kind: 'known', observedAt: 'now', records: [] },
    };
    expect(buildAssociationRequests({ snapshot, queues, cache: [] })).toEqual([]);
    const unknownLibrary = { ...snapshot, sonarr: { ...snapshot.sonarr, known: false } };
    expect(buildAssociationRequests({ snapshot: unknownLibrary, queues: queueReads([{ id: 1, title: 'The Example' }]), cache: [] })).toEqual([]);
  });
});
