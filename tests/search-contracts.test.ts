import { describe, expect, it } from 'vitest';
import { searchRequestSchema, searchActionSchema, episodeSetActionSchema, searchStatusSchema, rankedOptionSchema, submissionRequestSchema } from '../src/search/contracts';

describe('neutral search contracts', () => {
  it('accepts prompt-only requests and keeps preferences descriptive', () => {
    expect(searchRequestSchema.parse({ prompt: 'Find the film', preferences: { audioLanguages: ['ja'] } })).toMatchObject({ prompt: 'Find the film' });
    expect(searchRequestSchema.safeParse({ prompt: '  ' }).success).toBe(false);
  });
  it('constrains model actions to read-only list/search/finish', () => {
    expect(searchActionSchema.safeParse({ action: 'search_releases', query: 'alt title', categories: null, indexerIds: null, status: null, options: null, message: null }).success).toBe(true);
    expect(searchActionSchema.safeParse({ action: 'submit', query: null, categories: null, indexerIds: null, status: null, options: null, message: null }).success).toBe(false);
  });
  it('rejects hard requirements and models nullable finish fields for strict providers', () => {
    expect(searchRequestSchema.safeParse({ prompt: 'Find it', requirements: { subtitleLanguages: ['en'] } }).success).toBe(false);
    expect(searchActionSchema.safeParse({ action: 'finish', query: null, categories: null, indexerIds: null, status: 'needs-input', options: null, message: 'Which title?' }).success).toBe(true);
  });
  it('defines terminal and progress outcomes and opaque ranked options', () => {
    expect(searchStatusSchema.safeParse('needs-input').success).toBe(true);
    expect(searchStatusSchema.safeParse('imported').success).toBe(false);
    expect(rankedOptionSchema.safeParse({ optionId: 'o1', rank: 1, releases: [{ candidateId: 'c1' }], coveredTargetIds: [], reason: 'Best fit', uncertainty: 'Unknown audio' }).success).toBe(true);
    expect(rankedOptionSchema.safeParse({ optionId: 'o1', rank: 1, releases: [{ candidateId: 'c1', url: 'https://private' }], coveredTargetIds: [], reason: 'x', uncertainty: '' }).success).toBe(false);
  });
  it('requires explicit submission references and idempotency key', () => {
    expect(submissionRequestSchema.safeParse({ searchId: 's1', optionId: 'o1', idempotencyKey: 'k1' }).success).toBe(true);
    expect(submissionRequestSchema.safeParse({ searchId: 's1', optionId: 'o1', url: 'magnet:?x' }).success).toBe(false);
  });
  it('accepts bounded episode-set context and rejects wire fields that are absent or oversized', () => {
    const episodeSet = { prompt: 'Plan the aired episodes', context: { kind: 'tv', scope: { type: 'episode-set' }, targets: [{ targetId: 'a', seasonNumber: 1, episodeNumber: 2, title: 'Ep', airDateUtc: null }] } };
    expect(searchRequestSchema.safeParse(episodeSet).success).toBe(true);
    expect(searchRequestSchema.safeParse({ ...episodeSet, context: { ...episodeSet.context, targets: Array.from({ length: 201 }, (_, i) => ({ targetId: `e${i}` })) } }).success).toBe(false);
  });
  it('requires distinct acquisition targets for a batch without changing legacy target limits', () => {
    const batch = (targets?: Array<{ targetId: string }>) => ({ prompt: 'Plan episodes', context: { scope: { type: 'episode-set' }, targets } });
    expect(searchRequestSchema.safeParse(batch()).success).toBe(false);
    expect(searchRequestSchema.safeParse(batch([])).success).toBe(false);
    expect(searchRequestSchema.safeParse(batch([{ targetId: 'a' }, { targetId: 'a' }])).success).toBe(false);
    expect(searchRequestSchema.safeParse({ prompt: 'Find season', context: { scope: { type: 'season' }, targets: Array.from({ length: 201 }, (_, i) => ({ targetId: `e${i}` })) } }).success).toBe(true);
  });
  it('keeps batch action wire shape strict and nullable without model-computed aggregate fields', () => {
    const release = { candidateId: 'c', coveredTargetIds: ['t'], coverageReason: 'title and numbering align', uncertainty: 'inferred' };
    const action = { action: 'finish', query: null, categories: null, indexerIds: null, status: 'matched', options: [{ optionId: 'p', rank: 1, releases: [release], reason: 'good plan', uncertainty: '' }], message: null };
    expect(episodeSetActionSchema.safeParse(action).success).toBe(true);
    expect(episodeSetActionSchema.safeParse({ ...action, options: [{ ...action.options[0], coverage: 'complete' }] }).success).toBe(false);
    expect(episodeSetActionSchema.safeParse({ ...action, message: undefined }).success).toBe(false);
  });
});
