import { describe, expect, it } from 'vitest';
import { finalizeReleaseSet, normalizeAgentRequest } from '../src/search/agent-contracts';

describe('agent release-set contract', () => {
  it('requires explicit missing scope for partial broad coverage and forbids complete coverage with gaps', () => {
    const ledger = { searchId: 'broad', targets: [], candidates: [{ id: 'a', physicalId: 'p', targets: [] }] };
    const selected = { status: 'matched', selections: [{ candidateId: 'a', targetIds: [], reason: 'Observed pack', uncertainty: '' }], gaps: [], deferred: [] };
    expect(() => finalizeReleaseSet({ ...selected, broadCoverage: 'partial', scopeGaps: [] }, ledger)).toThrow('Partial coverage requires explicit gaps');
    expect(() => finalizeReleaseSet({ ...selected, broadCoverage: 'complete', scopeGaps: ['Season 4'] }, ledger)).toThrow(/requested-scope gaps/i);
  });
  it('normalizes legacy requests without conflating owned context with acquisition targets', () => {
    const request = normalizeAgentRequest({
      prompt: 'Find the series',
      context: {
        kind: 'tv', titles: [' Series '], scope: { type: 'episode-set' },
        targets: [{ targetId: 'wanted-1', seasonNumber: 1, episodeNumber: 1 }],
        relatedEpisodes: [{ episodeRef: 'owned-2', seasonNumber: 1, episodeNumber: 2, hasFile: true, queued: false, monitored: true, available: true, contextReason: 'already owned' }],
      },
    });
    expect(request.intents).toEqual([{ id: 'wanted-1', type: 'episode', season: 1, episode: 1 }]);
    expect(request.context).toEqual(['already owned']);
    expect(request.contextEpisodes).toEqual([{ id: 'owned-2', season: 1, episode: 2, contextReason: 'already owned', hasFile: true, queued: false, monitored: true, available: true }]);
    expect(request.version).toBe(1);
  });

  it('normalizes a generic movie request to an explicit stable acquisition intent', () => {
    const request = normalizeAgentRequest({ prompt: 'Find Arrival', context: { kind: 'movie', titles: ['Arrival'], year: 2016, scope: { type: 'movie' } } });
    expect(request.intents).toEqual([{ id: 'movie:arrival:2016', type: 'movie' }]);
    expect(request.scope).toBe('movie');
  });

  it('preserves ordinary episode/season numbering and search preferences', () => {
    const episode = normalizeAgentRequest({
      prompt: 'Find pilot', preferences: { audioLanguages: ['Japanese'] },
      context: { kind: 'tv', titles: ['Show'], scope: { type: 'episode', seasonNumber: 0, episodeNumber: 2, absoluteEpisodeNumber: 2 }, originalLanguage: 'ja', seriesType: 'anime', episodeTitle: 'Pilot' },
    });
    expect(episode.intents).toEqual([{ id: 'episode:0:2:2', type: 'episode', season: 0, episode: 2, absoluteEpisode: 2 }]);
    expect(episode.showMetadata).toMatchObject({ originalLanguage: 'ja', seriesType: 'anime', episodeTitle: 'Pilot' });
    expect(episode.preferences).toMatchObject({ audioLanguages: ['Japanese'] });
    const season = normalizeAgentRequest({ prompt: 'Season one', context: { kind: 'tv', scope: { type: 'season', seasonNumber: 1 } } });
    expect(season.intents).toEqual([{ id: 'season:1', type: 'season', season: 1 }]);
  });

  it('keeps arbitrary generic target IDs separate from explicit Arr targets', () => {
    const generic = normalizeAgentRequest({ prompt: 'Find episodes', context: {
      kind: 'tv', scope: { type: 'episode-set' },
      targets: [{ targetId: 'opaque-not-a-hash', seasonNumber: 1, episodeNumber: 2 }],
    } });
    expect(generic.targetIds).toEqual(['opaque-not-a-hash']);
    expect(generic.arrTargetIds).toEqual([]);
    const arr = normalizeAgentRequest({ prompt: 'Find these', arrTargetIds: ['arr-opaque'] });
    expect(arr.arrTargetIds).toEqual(['arr-opaque']);
    expect(arr.targetIds).toEqual([]);
  });

  it('merges explicit scope numbering into target intents and rejects contradictions', () => {
    const merged = normalizeAgentRequest({ prompt: 'Episode 2', context: {
      kind: 'tv', scope: { type: 'episode', seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: 26 },
      targets: [{ targetId: 'request-episode', seasonNumber: 1, episodeNumber: 2 }],
    } });
    expect(merged.intents).toEqual([{ id: 'request-episode', type: 'episode', season: 1, episode: 2, absoluteEpisode: 26 }]);
    expect(() => normalizeAgentRequest({ prompt: 'Contradictory', context: {
      kind: 'tv', scope: { type: 'episode', seasonNumber: 1, episodeNumber: 2 },
      targets: [{ targetId: 'request-episode', seasonNumber: 1, episodeNumber: 3 }],
    } })).toThrow(/conflict/i);
  });

  it('accepts overlapping observed releases, partial union and no-match with no selection', () => {
    const candidates = [
      { id: 'a', physicalId: 'physical-a', targets: ['t1', 't2'] },
      { id: 'b', physicalId: 'physical-b', targets: ['t2'] },
    ];
    expect(finalizeReleaseSet({ status: 'matched', selections: [{ candidateId: 'a', targetIds: ['t1', 't2'], reason: 'pack coverage', uncertainty: '' }, { candidateId: 'b', targetIds: ['t2'], reason: 'overlap', uncertainty: '' }], gaps: [], deferred: [] }, {
      searchId: 's', targets: ['t1', 't2'], candidates,
    }).coverage).toEqual({ covered: ['t1', 't2'], gaps: [], deferred: [], broad: { status: 'unknown', gaps: [] } });
    expect(finalizeReleaseSet({ status: 'no-match', selections: [], gaps: ['t1'], deferred: [] }, {
      searchId: 's', targets: ['t1'], candidates: [],
    }).status).toBe('no-match');
  });

  it('rejects foreign targets, duplicate physical releases and explicit identity conflicts', () => {
    const ctx = { searchId: 's', targets: ['t1'], candidates: [
      { id: 'a', physicalId: 'same', targets: ['t1'], identityConflict: false },
      { id: 'b', physicalId: 'same', targets: ['t1'], identityConflict: false },
      { id: 'c', physicalId: 'other', targets: ['t1'], identityConflict: true },
    ] };
    for (const selection of [
      [{ candidateId: 'a', targetIds: ['foreign'], reason: 'x', uncertainty: '' }],
      [{ candidateId: 'a', targetIds: ['t1'], reason: 'x', uncertainty: '' }, { candidateId: 'b', targetIds: ['t1'], reason: 'x', uncertainty: '' }],
      [{ candidateId: 'c', targetIds: ['t1'], reason: 'x', uncertainty: '' }],
    ]) expect(() => finalizeReleaseSet({ status: 'matched', selections: selection, gaps: [], deferred: [] }, ctx)).toThrow();
  });

  it('does not infer full broad-scope coverage from a selected release', () => {
    const result = finalizeReleaseSet({
      status: 'matched', selections: [{ candidateId: 'a', targetIds: [], reason: 'covers three seasons', uncertainty: 'season four unknown' }],
      gaps: [], deferred: [], broadCoverage: 'partial', scopeGaps: ['Season 4 remains unresolved'],
    }, { searchId: 'broad', targets: [], candidates: [{ id: 'a', physicalId: 'p', targets: [] }] });
    expect(result.coverage.broad).toEqual({ status: 'partial', gaps: ['Season 4 remains unresolved'] });
    expect(result.planId).toBeTruthy();
  });

  it('treats incidental broad pack overcoverage as a warning, not an unmet scope gap', () => {
    const result = finalizeReleaseSet({
      status: 'matched', selections: [{ candidateId: 'pack', targetIds: [], reason: 'Requested seasons covered', uncertainty: '' }],
      gaps: [], deferred: [], broadCoverage: 'complete', scopeGaps: [], warnings: ['Pack also includes seasons 1–3'],
    }, { searchId: 'broad', targets: [], candidates: [{ id: 'pack', physicalId: 'p', targets: [] }] });
    expect(result.coverage.broad).toEqual({ status: 'complete', gaps: [] });
    expect(result.warnings).toEqual(['Pack also includes seasons 1–3']);
    expect(() => finalizeReleaseSet({
      status: 'matched', selections: [{ candidateId: 'pack', targetIds: [], reason: 'pack', uncertainty: '' }],
      gaps: [], deferred: [], broadCoverage: 'complete', scopeGaps: ['Extra season in pack'],
    }, { searchId: 'broad', targets: [], candidates: [{ id: 'pack', physicalId: 'p', targets: [] }] })).toThrow(/requested-scope gaps/i);
  });
});
