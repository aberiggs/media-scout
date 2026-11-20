import { describe, expect, it } from 'vitest';
import { searchRequestSchema, searchStatusSchema } from '../src/search/contracts';

describe('search request contract', () => {
  it('accepts prompt-only and descriptive preference requests', () => {
    expect(searchRequestSchema.parse({ prompt: 'Find the film', preferences: { audioLanguages: ['ja'] } })).toMatchObject({ prompt: 'Find the film' });
    expect(searchRequestSchema.safeParse({ prompt: '  ' }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ prompt: 'Find it', requirements: { subtitleLanguages: ['en'] } }).success).toBe(false);
  });
  it('keeps generic target references opaque and validates explicit Arr refs separately', () => {
    expect(searchRequestSchema.safeParse({ prompt: 'Find it', context: { scope: { type: 'episode-set' }, targets: [{ targetId: 'any-opaque-value' }] } }).success).toBe(true);
    expect(searchRequestSchema.safeParse({ prompt: 'Find it', arrTargetIds: ['opaque-arr-id'] }).success).toBe(true);
    expect(searchRequestSchema.safeParse({ prompt: 'Find it', arrTargetIds: ['same', 'same'] }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ prompt: 'Find it', arrTargetIds: Array.from({ length: 201 }, (_, i) => `arr-${i}`) }).success).toBe(false);
  });
  it('preserves current episode-set request bounds without imposing model action schemas', () => {
    const request = { prompt: 'Plan episodes', context: { scope: { type: 'episode-set' }, targets: [{ targetId: 'a' }] } };
    expect(searchRequestSchema.safeParse(request).success).toBe(true);
    expect(searchRequestSchema.safeParse({ ...request, context: { ...request.context, targets: Array.from({ length: 201 }, (_, i) => ({ targetId: `e${i}` })) } }).success).toBe(false);
  });
  it('distinguishes search status from downstream import', () => {
    expect(searchStatusSchema.safeParse('needs-input').success).toBe(true);
    expect(searchStatusSchema.safeParse('imported').success).toBe(false);
  });
});
