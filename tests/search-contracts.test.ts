import { describe, expect, it } from 'vitest';
import { searchRequestSchema, searchStatusSchema } from '../src/search/contracts';

describe('search request contract', () => {
  it('accepts only a prompt and rejects former fields and unknown fields', () => {
    expect(searchRequestSchema.parse({ prompt: 'Find the film' })).toEqual({ prompt: 'Find the film' });
    expect(searchRequestSchema.safeParse({ prompt: '  ' }).success).toBe(false);
    expect(searchRequestSchema.parse({ prompt: '  Find it\nexactly  ' }).prompt).toBe('  Find it\nexactly  ');
    for (const field of ['context', 'preferences', 'arrTargetIds', 'preferredDownloadClientId', 'other']) {
      expect(searchRequestSchema.safeParse({ prompt: 'Find it', [field]: field === 'arrTargetIds' ? [] : 'legacy' }).success).toBe(false);
    }
  });
  it('distinguishes search status from downstream import', () => {
    expect(searchStatusSchema.safeParse('needs-input').success).toBe(true);
    expect(searchStatusSchema.safeParse('imported').success).toBe(false);
  });
});
