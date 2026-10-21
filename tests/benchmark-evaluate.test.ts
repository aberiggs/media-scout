import { describe, expect, it } from 'vitest';
import { evaluateBenchmarkCase, evaluateRecordedCase, frozenQuery } from '../src/benchmarks/evaluate';
import type { DatasetCaseSchema } from '../src/benchmarks/contracts';
import type { LLMClient } from '../src/clients/llm';

const c = {
  id: 'x', partition: 'development', input: { kind: 'tv', title: 'Show', altTitles: [], externalId: 'tvdb:1', year: null, seasonNumber: 1, episodes: [{ episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot' }] },
  candidates: [{ id: 'a', title: 'Show S01E01 1080p', downloadPresent: true, magnetPresent: false, size: 100, seeders: 10, leechers: 0, grabs: 1, age: 1, externalIds: [], protocol: 'torrent', categories: [5070], source: 'ix', review: { identity: 'compatible', coveredEpisodeNumbers: [1], coverageBasis: 'explicit', selection: 'acceptable', reason: 'reviewed' } }],
  queries: [{ query: 'Show S01', categories: [5070], indexers: ['ix'], limit: 10, candidateIds: ['a'], availability: 'success', completeness: 'upstream-completeness-unknown' }],
  label: { identity: 'compatible', coveredEpisodeNumbers: [1], coverageBasis: 'explicit', selection: 'acceptable', acceptableCandidateIds: ['a'], reason: 'reviewed' },
} as import('zod').infer<typeof DatasetCaseSchema>;
const llm: LLMClient = { async json<T>(args: { schema: import('zod').ZodType<T> }) { return args.schema.parse({ verdict: 'grab', releaseIndex: 0, reason: 'best' }); } };

describe('benchmark evaluation', () => {
  it('reports an unrecorded planner query as unsupported instead of treating it as an empty retrieval', async () => {
    const planner: LLMClient = { async json<T>(args: { schema: import('zod').ZodType<T> }) { return args.schema.parse([{ query: 'Show S01 complete', categories: [5070] }]); } };
    const result = await evaluateBenchmarkCase(c, 'replay', planner);
    expect(result.status).toBe('unsupported-retrieval');
    expect(result.unsupportedQueryCount).toBe(1);
    expect(result.selectedIds).toEqual([]);
  });

  it('credits a valid acceptable candidate through the production single picker', async () => {
    const result = await evaluateBenchmarkCase(c, 'pick-single', llm);
    expect(result.status).toBe('correct');
    expect(result.selectedIds).toEqual(['a']);
  });
  it('exercises grouped planner attribution rather than the single planner schema', async () => {
    const group: LLMClient = { async json(args) { expect(JSON.parse(args.user).searchStage).toBe('episodes'); return args.schema.parse({ queries: [{ query: 'Show S01', categories: [5070], targetIndices: [0], episodeTargets: [{ targetIndex: 0, episodeIndices: [0] }] }] }); } };
    expect((await evaluateBenchmarkCase(c, 'plan-group', group)).status).toBe('correct');
  });
  it('retains unsafe fabricated references even when the production validator rejects them', async () => {
    const bad: LLMClient = { async json(args) { return args.schema.parse({ verdict: 'grab', releaseIndex: 99, reason: 'fabricated' }); } };
    const out = await evaluateBenchmarkCase(c, 'pick-single', bad);
    expect(out.validatorRejected).toBe(true);
    expect(out.unsafe).toBe(true);
    expect(out.rawIndices).toEqual([99]);
  });
  it('exercises group selection validation and blocks overlapping choices', async () => {
    const group: LLMClient = { async json(args) { return args.schema.parse({ selection: { verdict: 'grab', releaseIndices: [0, 0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'duplicate' } }); } };
    const out = await evaluateBenchmarkCase(c, 'pick-group', group);
    expect(out.validatorRejected).toBe(true);
    expect(out.unsafe).toBe(true);
  });
  it('exercises real association references on mixed-provenance synthetic queue context', async () => {
    const association: LLMClient = { async json(args) { return args.schema.parse({ decisions: [{ queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'match' }] }); } };
    expect((await evaluateBenchmarkCase(c, 'association', association)).status).toBe('correct');
  });
  it('does not let a supported query see candidates returned only by another query', async () => {
    const sample = { ...c, queries: [{ ...c.queries[0]!, candidateIds: [] }] };
    const planner: LLMClient = { async json(args) { return args.schema.parse({ queries: [{ query: 'Show S01', categories: [5070] }] }); } };
    const out = await evaluateBenchmarkCase(sample, 'replay', planner);
    expect(out.retrievedIds).toEqual([]);
    expect(out.status).toBe('justified-abstention');
    expect(out.poolRecall).toBe(0);
  });
  it.each(['NotShow S01', 'Show S01E999', 'Show 2099'])('flags fabricated planner identity/scope: %s', async query => {
    const planner: LLMClient = { async json(args) { return args.schema.parse({ queries: [{ query, categories: [5070] }] }); } };
    expect((await evaluateBenchmarkCase(c, 'plan-single', planner)).unsafe).toBe(true);
  });
  it('preserves captured order through replay before stable seeder ties', async () => {
    const sample = { ...c, candidates: [c.candidates[0]!, { ...c.candidates[0]!, id: 'b' }], queries: [{ ...c.queries[0]!, candidateIds: ['b', 'a'] }], label: { ...c.label, acceptableCandidateIds: ['a', 'b'] } };
    const llm: LLMClient = { async json(args) { return args.schema.parse(args.label.startsWith('planner:') ? { queries: [{ query: 'Show S01', categories: [5070] }] } : { verdict: 'grab', releaseIndex: 0, reason: 'first' }); } };
    const out = await evaluateBenchmarkCase(sample, 'replay', llm);
    expect(out.retrievedIds).toEqual(['b', 'a']);
    expect(out.selectedIds).toEqual(['b']);
  });
  it('keeps frozen indexer/limit changes unsupported and unavailable responses distinct', () => {
    expect(frozenQuery(c, { query: 'Show S01', categories: [5070], indexers: ['other'], limit: 10 })).toBeUndefined();
    expect(frozenQuery(c, { query: 'Show S01', categories: [5070], indexers: ['ix'], limit: 200 })).toBeUndefined();
  });
  it('runs offline recorded outputs without a provider and accepts multiple correct candidates', async () => {
    const sample = { ...c, candidates: [c.candidates[0]!, { ...c.candidates[0]!, id: 'b' }], label: { ...c.label, acceptableCandidateIds: ['a', 'b'] } };
    for (const releaseIndex of [0, 1]) expect((await evaluateRecordedCase(sample, 'pick-single', [{ verdict: 'grab', releaseIndex, reason: 'one acceptable option' }])).status).toBe('correct');
  });
  it('refuses held targets before any model call and treats ambiguous association matches as unsafe', async () => {
    const held = { ...c, held: true };
    expect((await evaluateRecordedCase(held, 'pick-group', [])).status).toBe('justified-abstention');
    const uncertain = { ...c, associationExpectation: 'uncertain' as const, queueTitle: 'Show', label: { ...c.label, selection: 'uncertain' as const, acceptableCandidateIds: [] } };
    const result = await evaluateRecordedCase(uncertain, 'association', [{ decisions: [{ queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [0], reason: 'guess' }] }]);
    expect(result.unsafe).toBe(true);
  });
  it('does not manufacture identity or season crosswalks for incomplete metadata', async () => {
    expect((await evaluateRecordedCase({ ...c, input: { ...c.input, externalId: null } }, 'plan-single', [])).status).toBe('uncertain');
    expect((await evaluateRecordedCase({ ...c, input: { ...c.input, seasonNumber: null } }, 'plan-group', [])).status).toBe('uncertain');
  });
  it('credits an acceptable partial selection while reporting its limited target coverage', async () => {
    const partial = { ...c, input: { ...c.input, episodes: [...c.input.episodes, { episodeNumber: 2, absoluteEpisodeNumber: null, title: 'Next' }] }, label: { ...c.label, coveredEpisodeNumbers: [1, 2] } };
    const out = await evaluateRecordedCase(partial, 'pick-single', [{ verdict: 'grab', releaseIndex: 0, reason: 'partial acceptable' }]);
    expect(out.status).toBe('correct');
    expect(out.identityCorrect).toBe(true);
    expect(out.claimedTargetCoverage).toBe(0.5);
    expect(out.selectionCoverageBasis).toBe('explicit');
  });
  it('scores declared preference tiers without requiring one exact winner', async () => {
    const tiered = { ...c, candidates: [{ ...c.candidates[0]!, review: { ...c.candidates[0]!.review!, preferenceTier: 0 } }, { ...c.candidates[0]!, id: 'b', review: { ...c.candidates[0]!.review!, preferenceTier: 1 } }], label: { ...c.label, acceptableCandidateIds: ['a', 'b'] } };
    const result = await evaluateRecordedCase(tiered, 'pick-single', [{ verdict: 'grab', releaseIndex: 1, reason: 'also acceptable' }]);
    expect(result.status).toBe('correct');
    expect(result.preferenceCredit).toBe(0.5);
  });
  it('reports cap losses separately instead of blaming the picker for an unseen acceptable release', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({ ...c.candidates[0]!, id: `r${index}`, seeders: index, title: index === 0 ? 'Show S01E01' : `Other Work ${index} S01E01`, review: { ...c.candidates[0]!.review!, identity: index === 0 ? 'compatible' as const : 'wrong' as const, selection: index === 0 ? 'acceptable' as const : 'unacceptable' as const } }));
    const sample = { ...c, candidates, queries: [{ ...c.queries[0]!, candidateIds: candidates.map(r => r.id) }], label: { ...c.label, acceptableCandidateIds: ['r0'] } };
    const out = await evaluateRecordedCase(sample, 'pick-single', [{ verdict: 'skip', releaseIndex: null, reason: 'wrong works shown' }]);
    expect(out.admittedIds).toHaveLength(101);
    expect(out.cappedIds).toHaveLength(100);
    expect(out.capLossIds).toEqual(['r0']);
    expect(out.status).toBe('justified-abstention');
  });
  it('keeps an unavailable captured response distinct from a successful empty pool', async () => {
    const unavailable = { ...c, queries: [{ ...c.queries[0]!, candidateIds: [], availability: 'unavailable' as const }] };
    const out = await evaluateRecordedCase(unavailable, 'replay', [{ queries: [{ query: 'Show S01', categories: [5070] }] }]);
    expect(out.status).toBe('retrieval-unavailable');
    expect(out.supportedQueryCount).toBe(1);
    expect(out.poolRecall).toBeNull();
  });
  it('distinguishes seasonal numbering roles from merely present numbers', async () => {
    const two = { ...c, input: { ...c.input, episodes: [...c.input.episodes, { episodeNumber: 2, absoluteEpisodeNumber: null, title: 'Next' }] } };
    expect((await evaluateRecordedCase(two, 'plan-single', [{ queries: [{ query: 'Show Season 2', categories: [5070] }] }])).unsafe).toBe(true);
    const anime = { ...c, input: { ...c.input, kind: 'anime' as const, episodes: [{ ...c.input.episodes[0]!, absoluteEpisodeNumber: 26 }] } };
    expect((await evaluateRecordedCase(anime, 'plan-single', [{ queries: [{ query: 'Show S01E26', categories: [5070] }] }])).unsafe).toBe(true);
  });
  it('allows a grounded word-to-number sequel title without demanding an exact output string', async () => {
    const movie = { ...c, input: { kind: 'movie' as const, title: 'Dune: Part Two', altTitles: [], externalId: 'tmdb:1', year: 2024, seasonNumber: null, episodes: [] } };
    expect((await evaluateRecordedCase(movie, 'plan-single', [{ queries: [{ query: 'Dune Part 2 2024', categories: [2000] }] }])).unsafe).toBe(false);
  });
});
