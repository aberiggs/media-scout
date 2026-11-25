import { describe, expect, it } from 'vitest';
import { episodeAiring, offsetEligibilityTime } from '../src/core/episode-timing';

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
    const airing = episodeAiring({ airDate, airDateUtc });
    expect(airing ? new Date(airing.airAt).toISOString() : null).toBe(expected);
  });

  it('moves the conservative eligibility instant earlier without inventing dates', () => {
    const precise = episodeAiring({ airDate: '2026-10-15', airDateUtc: '2026-10-15T23:00:00Z' })!;
    const dateOnly = episodeAiring({ airDate: '2026-10-15', airDateUtc: null })!;
    expect(precise.metadataAirDate).toBe('2026-10-15T23:00:00.000Z');
    expect(dateOnly.metadataAirDate).toBe('2026-10-15');
    expect(offsetEligibilityTime(precise.airAt, 72)).toBe(Date.parse('2026-10-12T23:00:00Z'));
    expect(offsetEligibilityTime(dateOnly.airAt, 72)).toBe(Date.parse('2026-10-13T00:00:00Z'));
    expect(offsetEligibilityTime(episodeAiring({ airDate: null, airDateUtc: null })?.airAt, 72)).toBeUndefined();
  });
});
