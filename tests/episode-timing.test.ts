import { describe, expect, it } from 'vitest';
import { episodeEligibilityTime } from '../src/core/episode-timing';

describe('episode eligibility timing', () => {
  it.each([
    ['2026-10-15', '2026-10-15T23:00:00Z', '2026-10-15T23:00:00.000Z'],
    ['2026-10-20', '2026-10-15T23:00:00Z', '2026-10-15T23:00:00.000Z'],
    ['2026-10-14', null, '2026-10-15T00:00:00.000Z'],
    ['2024-02-29', null, '2024-03-01T00:00:00.000Z'],
    ['2026-02-30', null, null],
    [null, '2026-02-30T23:00:00Z', null],
    [null, '2026-10-15Z', null],
    ['2026-10-14', 'invalid', '2026-10-15T00:00:00.000Z'],
    [null, null, null],
  ])('normalizes calendar %s and precise %s to %s', (airDate, airDateUtc, expected) => {
    // Accepting a rolled-over or non-timestamp precise value must not authorize acquisition.
    expect(episodeEligibilityTime({ airDate, airDateUtc })?.toISOString() ?? null).toBe(expected);
  });
});
