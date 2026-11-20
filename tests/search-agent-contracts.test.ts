import { describe, expect, it } from 'vitest';
import { finalizeReleaseSet, finalizeReleaseSetInputSchema, normalizeAgentRequest, releaseSetSchema } from '../src/search/agent-contracts';
import { searchRequestSchema } from '../src/search/contracts';

describe('agent release-set contract', () => {
  it('requires explicit missing scope for partial broad coverage and forbids complete coverage with gaps', () => {
    const ledger = { searchId: 'broad', candidates: [{ id: 'a', physicalId: 'p' }] };
    const selected = { status: 'matched', selections: [{ candidateId: 'a', coverage: 'Seasons 1–3', reason: 'Observed pack', uncertainty: '' }], covered: ['Seasons 1–3'], gaps: [], deferred: [], scopeGaps: [] };
    expect(() => finalizeReleaseSet({ ...selected, broadCoverage: 'partial', scopeGaps: [] }, ledger)).toThrow(/partial broad coverage requires explicit gaps/i);
    expect(() => finalizeReleaseSet({ ...selected, broadCoverage: 'complete', scopeGaps: ['Season 4'] }, ledger)).toThrow(/complete broad coverage cannot contain gaps/i);
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

  it('accepts a positive preferred client in search requests but excludes it from model input', () => {
    const request=searchRequestSchema.parse({prompt:'Find a film',preferredDownloadClientId:987654});
    expect(request.preferredDownloadClientId).toBe(987654);
    expect(normalizeAgentRequest(request)).not.toHaveProperty('preferredDownloadClientId');
    expect(searchRequestSchema.safeParse({prompt:'Find a film',preferredDownloadClientId:0}).success).toBe(false);
    expect(searchRequestSchema.safeParse({prompt:'Find a film',preferredDownloadClientId:1.5}).success).toBe(false);
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

  it('accepts semantic release coverage and useful overlap without Arr target mapping', () => {
    const candidates = [
      { id: 'a', physicalId: 'physical-a' },
      { id: 'b', physicalId: 'physical-b' },
    ];
    expect(finalizeReleaseSet({ status: 'matched', selections: [
      { candidateId: 'a', coverage: 'Seasons 1–2', reason: 'Useful two-season pack', uncertainty: '' },
      { candidateId: 'b', coverage: 'Episodes 8–10', reason: 'Adds remaining episodes', uncertainty: 'Some overlap with the first pack' },
    ], covered: ['Seasons 1–2', 'Episodes 8–10'], gaps: [], deferred: [], broadCoverage: 'complete', scopeGaps: [], usefulOverlap: ['The second pack repeats episode 8'] }, {
      searchId: 's', candidates,
    })).toMatchObject({ version: 2, coverage: { covered: ['Seasons 1–2', 'Episodes 8–10'], gaps: [], deferred: [], broad: { status: 'complete', gaps: [] } }, usefulOverlap: ['The second pack repeats episode 8'] });
    expect(finalizeReleaseSet({ status: 'no-match', selections: [], covered: [], gaps: [], deferred: [], broadCoverage: 'none', scopeGaps: [] }, {
      searchId: 's', candidates: [],
    }).status).toBe('no-match');
  });

  it('accepts descriptive release coverage independent of Arr target IDs', () => {
    const plan = finalizeReleaseSet({ status: 'matched', selections: [
      { candidateId: 'pack-a', coverage: 'Seasons 1–3', reason: 'Useful season pack', uncertainty: '' },
      { candidateId: 'pack-b', coverage: 'Remaining episodes in season 3', reason: 'Adds several episodes', uncertainty: 'Episode listing inferred from title' },
    ], covered: ['Seasons 1–3'], gaps: [], deferred: [], broadCoverage: 'partial', scopeGaps: ['Season 4 not observed'], extras: ['Pack B also includes specials'], usefulOverlap: ['Some season 3 episodes overlap'] }, {
      searchId: 's', candidates: [
        { id: 'pack-a', physicalId: 'p1' }, { id: 'pack-b', physicalId: 'p2' },
      ],
    });
    expect(plan.version).toBe(2);
    expect(plan.selections.map(x => x.candidateId)).toEqual(['pack-a', 'pack-b']);
    expect(plan.coverage.covered).toEqual(['Seasons 1–3']);
    expect(plan.extras).toEqual(['Pack B also includes specials']);
    expect(plan.usefulOverlap).toEqual(['Some season 3 episodes overlap']);
    expect(plan.coverage.covered).not.toContain('t1');
  });

  it('does not expose target assignments in the finalizer schema and rejects contradictory broad coverage', () => {
    const ledger = { searchId: 's', candidates: [{ id: 'a', physicalId: 'p' }] };
    const semantic = { status: 'matched', selections: [{ candidateId: 'a', coverage: 'The requested film', reason: 'Matches title and year', uncertainty: '' }], covered: ['The requested film'], gaps: [], deferred: [], broadCoverage: 'complete', scopeGaps: [] };
    expect(finalizeReleaseSetInputSchema.safeParse({ ...semantic, selections: [{ ...semantic.selections[0], targetIds: ['opaque-arr-id'] }] }).success).toBe(false);
    expect(() => finalizeReleaseSet({ ...semantic, covered: [] }, ledger)).toThrow(/plain-language coverage/i);
    expect(() => finalizeReleaseSet({ ...semantic, gaps: ['The requested film is missing'] }, ledger)).toThrow(/complete.*gap/i);
    expect(() => finalizeReleaseSet({ ...semantic, deferred: ['The requested film'] }, ledger)).toThrow(/complete.*gap|deferred/i);
    expect(() => finalizeReleaseSet({ ...semantic, status: 'no-match', selections: [], covered: [], broadCoverage: 'complete' }, ledger)).toThrow(/complete.*matched/i);
  });

  it('rejects foreign candidates, duplicate physical releases and explicit identity conflicts', () => {
    const ctx = { searchId: 's', candidates: [
      { id: 'a', physicalId: 'same', identityConflict: false },
      { id: 'b', physicalId: 'same', identityConflict: false },
      { id: 'c', physicalId: 'other', identityConflict: true },
    ] };
    const common = { status: 'matched', covered: ['Requested season'], gaps: [], deferred: [], broadCoverage: 'complete', scopeGaps: [] };
    expect(() => finalizeReleaseSet({ ...common, selections: [{ candidateId: 'not-owned', coverage: 'Requested season', reason: 'x', uncertainty: '' }] }, ctx)).toThrow(/owning search/i);
    expect(() => finalizeReleaseSet({ ...common, selections: [
      { candidateId: 'a', coverage: 'Requested season', reason: 'x', uncertainty: '' },
      { candidateId: 'b', coverage: 'Requested season', reason: 'x', uncertainty: '' },
    ] }, ctx)).toThrow(/physical release/i);
    expect(() => finalizeReleaseSet({ ...common, selections: [{ candidateId: 'c', coverage: 'Requested season', reason: 'x', uncertainty: '' }] }, ctx)).toThrow(/identity conflict/i);
  });

  it('rejects historical v1 target assignment plans', () => {
    const legacy = {
      version: 1, planId: 'old-plan', status: 'matched',
      selections: [{ candidateId: 'old-candidate', targetIds: ['old-arr-target'], reason: 'legacy', uncertainty: '' }],
      gaps: [], deferred: [], coverage: { covered: ['old-arr-target'], gaps: [], deferred: [], broad: { status: 'complete', gaps: [] } },
    };
    expect(releaseSetSchema.safeParse(legacy).success).toBe(false);
    expect(finalizeReleaseSetInputSchema.safeParse(legacy).success).toBe(false);
  });

  it('does not infer full broad-scope coverage from a selected release', () => {
    const result = finalizeReleaseSet({
      status: 'matched', selections: [{ candidateId: 'a', coverage: 'Seasons 1–3', reason: 'Covers three seasons', uncertainty: 'Season four unknown' }],
      covered: ['Seasons 1–3'], gaps: [], deferred: [], broadCoverage: 'partial', scopeGaps: ['Season 4 remains unresolved'],
    }, { searchId: 'broad', candidates: [{ id: 'a', physicalId: 'p' }] });
    expect(result.coverage.broad).toEqual({ status: 'partial', gaps: ['Season 4 remains unresolved'] });
    expect(result.planId).toBeTruthy();
  });

  it('treats incidental broad pack overcoverage as a warning, not an unmet scope gap', () => {
    const result = finalizeReleaseSet({
      status: 'matched', selections: [{ candidateId: 'pack', coverage: 'Requested seasons', reason: 'Requested seasons covered', uncertainty: '' }],
      covered: ['Requested seasons'], gaps: [], deferred: [], broadCoverage: 'complete', scopeGaps: [], warnings: ['Pack also includes seasons 1–3'],
    }, { searchId: 'broad', candidates: [{ id: 'pack', physicalId: 'p' }] });
    expect(result.coverage.broad).toEqual({ status: 'complete', gaps: [] });
    expect(result.warnings).toEqual(['Pack also includes seasons 1–3']);
    expect(() => finalizeReleaseSet({
      status: 'matched', selections: [{ candidateId: 'pack', coverage: 'Some seasons', reason: 'pack', uncertainty: '' }],
      covered: ['Some seasons'], gaps: [], deferred: [], broadCoverage: 'complete', scopeGaps: ['Extra season in pack'],
    }, { searchId: 'broad', candidates: [{ id: 'pack', physicalId: 'p' }] })).toThrow(/complete broad coverage cannot contain gaps/i);
  });
});
