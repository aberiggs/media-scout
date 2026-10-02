import { describe, expect, it } from 'vitest';
import type { LLMClient } from '../src/clients/llm';
import { QueueAssociator, buildAssociationRequests } from '../src/core/queue-association';
import { reconcileWork, type QueueReads } from '../src/core/work-queue';
import type { LibrarySnapshot } from '../src/core/watcher';

class FakeLLM implements LLMClient {
  constructor(private readonly response: unknown) {}

  async json<T>(args: Parameters<LLMClient['json']>[0]): Promise<T> {
    return args.schema.parse(this.response) as T;
  }
}

describe('Gate 2 queue association regressions', () => {
  it('holds every potentially affected season for contradictory rows on one physical download without inventing coverage', async () => {
    const snapshot: LibrarySnapshot = {
      observedAt: '2026-10-01T10:00:00.000Z',
      sonarr: {
        known: true,
        series: [{
          known: true,
          series: {
            id: 11, tvdbId: 111, title: 'The Example', titleSlug: 'the-example', seriesType: 'standard', monitored: true,
            seasons: [
              { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 0, totalEpisodeCount: 2 } },
              { seasonNumber: 2, monitored: true, statistics: { episodeFileCount: 0, totalEpisodeCount: 1 } },
            ], alternateTitles: [],
          },
          episodes: [
            { id: 101, seriesId: 11, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'One', airDate: '2020-01-01', monitored: true, hasFile: false },
            { id: 102, seriesId: 11, seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: null, title: 'Two', airDate: '2020-01-08', monitored: true, hasFile: false },
            { id: 201, seriesId: 11, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Three', airDate: '2020-02-01', monitored: true, hasFile: false },
          ],
        }],
      },
      radarr: { known: true, movies: [] },
    };
    const queues: QueueReads = {
      sonarr: { kind: 'known', observedAt: snapshot.observedAt, records: [
        { id: 7, downloadId: 'job', title: 'The Example S01E01', seriesId: 11, seasonNumber: 1, status: 'downloading' },
        { id: 8, downloadId: 'job', title: 'The Example S01E02', seriesId: 11, seasonNumber: 1, status: 'downloading' },
      ] },
      radarr: { kind: 'known', observedAt: snapshot.observedAt, records: [] },
    };
    const [request] = buildAssociationRequests({ snapshot, queues, cache: [] });
    expect(request?.targets.map(({ seasonNumber }) => seasonNumber)).toEqual([1]);
    const [decision] = await new QueueAssociator({ llm: new FakeLLM({ decisions: [
      { queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'The media title matches.' },
    ] }) }).associate(request!);

    const result = reconcileWork({
      snapshot, queues, existingWorkItems: [], intents: [], now: snapshot.observedAt,
      minRetryHours: 6, queueGraceMin: 30, associationDecisions: [decision!],
    });
    expect(result.items.map(({ work, eligibleUnit, queueCoverage, activeCoverage, blockedReason }) => ({
      key: work.workKey,
      remainingEligibleIds: eligibleUnit?.season?.missing.map(({ episodeId }) => episodeId) ?? [],
      queueCoverage,
      activeCoverage,
      blockedReason,
    }))).toEqual([
      { key: 'sonarr:11:s1', remainingEligibleIds: [], queueCoverage: [], activeCoverage: [], blockedReason: 'queue-ambiguous' },
      { key: 'sonarr:11:s2', remainingEligibleIds: [], queueCoverage: [], activeCoverage: [], blockedReason: 'queue-ambiguous' },
    ]);
  });
});
