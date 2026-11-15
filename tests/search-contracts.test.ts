import { describe, expect, it } from 'vitest';
import { searchRequestSchema, searchActionSchema, searchStatusSchema, rankedOptionSchema, submissionRequestSchema } from '../src/search/contracts';

describe('neutral search contracts', () => {
  it('accepts prompt-only requests and keeps preferences descriptive', () => {
    expect(searchRequestSchema.parse({ prompt: 'Find the film', preferences: { audioLanguages: ['ja'] } })).toMatchObject({ prompt: 'Find the film' });
    expect(searchRequestSchema.safeParse({ prompt: '  ' }).success).toBe(false);
  });
  it('constrains model actions to read-only list/search/finish', () => {
    expect(searchActionSchema.safeParse({ action: 'search_releases', query: 'alt title' }).success).toBe(true);
    expect(searchActionSchema.safeParse({ action: 'submit', candidateId: 'c1' }).success).toBe(false);
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
});
