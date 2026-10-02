import { describe, expect, it } from 'vitest';
import { parseReleaseCoverage } from '../src/core/parser.js';
import { verifyGroupCoverage } from '../src/core/guardrails.js';
import type { WorkUnit } from '../src/core/watcher.js';

function tvUnit(seasonNumber: number, episodes: number[], seriesType: 'standard' | 'anime' = 'standard'): WorkUnit {
  return {
    key: `sonarr:1:s${seasonNumber}`,
    kind: 'tv',
    arr: 'sonarr',
    serviceId: 1,
    externalId: 100,
    title: 'Some Show',
    altTitles: [],
    seriesType,
    season: {
      seasonNumber,
      missing: episodes.map((episodeNumber) => ({
        episodeId: seasonNumber * 1000 + episodeNumber,
        episodeNumber,
        absoluteEpisodeNumber: episodeNumber,
        title: `Expected ${seasonNumber}.${episodeNumber}`,
      })),
    },
  };
}

function animeUnit(seasonNumber: number, entries: Array<{ episodeNumber: number; absoluteEpisodeNumber: number }>): WorkUnit {
  const unit = tvUnit(seasonNumber, [], 'anime');
  unit.season!.missing = entries.map((entry) => ({
    ...entry,
    episodeId: seasonNumber * 1000 + entry.episodeNumber,
    title: `Expected ${seasonNumber}.${entry.episodeNumber}`,
  }));
  return unit;
}

function check(title: string, originalUnits: WorkUnit[], actionableUnits = originalUnits) {
  return verifyGroupCoverage({ originalUnits, actionableUnits, parsed: parseReleaseCoverage(title) });
}

describe('verifyGroupCoverage', () => {
  it('maps a combined S1/S2 pack to two distinct requested footprints and one permitted capture', () => {
    const units = [tvUnit(1, [1, 2]), tvUnit(2, [1, 2])];
    const result = check('Some Show S01-S02 Complete', units);
    expect(result).toEqual({
      kind: 'covered',
      requestedFootprint: [
        { workKey: 'sonarr:1:s1', episodeIds: [1001, 1002], basis: 'inferred-season-pack' },
        { workKey: 'sonarr:1:s2', episodeIds: [2001, 2002], basis: 'inferred-season-pack' },
      ],
      capture: [
        { workKey: 'sonarr:1:s1', episodeIds: [1001, 1002], basis: 'inferred-season-pack' },
        { workKey: 'sonarr:1:s2', episodeIds: [2001, 2002], basis: 'inferred-season-pack' },
      ],
      extraSeasons: [],
    });
  });

  it('preserves per-season association for precise S01E02/S02E03 claims', () => {
    const result = check('Some Show S01E02 S02E03', [tvUnit(1, [2, 3]), tvUnit(2, [2, 3])]);
    expect(result).toMatchObject({
      kind: 'covered',
      requestedFootprint: [
        { workKey: 'sonarr:1:s1', episodeIds: [1002], basis: 'explicit-episodes' },
        { workKey: 'sonarr:1:s2', episodeIds: [2003], basis: 'explicit-episodes' },
      ],
      capture: [
        { workKey: 'sonarr:1:s1', episodeIds: [1002], basis: 'explicit-episodes' },
        { workKey: 'sonarr:1:s2', episodeIds: [2003], basis: 'explicit-episodes' },
      ],
    });
  });

  it('does not flatten same-numbered episodes across seasons', () => {
    expect(check('Some Show S01E02', [tvUnit(1, [2]), tvUnit(2, [2])])).toMatchObject({
      kind: 'covered',
      requestedFootprint: [{ workKey: 'sonarr:1:s1', episodeIds: [1002] }],
      capture: [{ workKey: 'sonarr:1:s1', episodeIds: [1002] }],
    });
  });

  it('rejects a known S3-only claim as no-map for a S1/S2 requested group', () => {
    expect(check('Some Show S03E02', [tvUnit(1, [2]), tvUnit(2, [2])])).toEqual({
      kind: 'no-map', reason: 'no-map',
    });
  });

  it('reports unrequested claimed seasons as extras but captures only requested S1/S2', () => {
    const units = [tvUnit(1, [1]), tvUnit(2, [1])];
    const result = check('Some Show S01-S03 Complete', units);
    expect(result).toMatchObject({
      kind: 'covered',
      extraSeasons: [3],
      requestedFootprint: [
        { workKey: 'sonarr:1:s1', episodeIds: [1001] },
        { workKey: 'sonarr:1:s2', episodeIds: [2001] },
      ],
      capture: [
        { workKey: 'sonarr:1:s1', episodeIds: [1001] },
        { workKey: 'sonarr:1:s2', episodeIds: [2001] },
      ],
    });
  });

  it('captures all supplied actionable targets for Complete Series, but never widens explicit episodes', () => {
    const original = [tvUnit(1, [1, 2]), tvUnit(2, [1, 2])];
    const complete = check('Some Show Complete Series', original, [original[0]!]);
    expect(complete).toMatchObject({
      kind: 'covered',
      requestedFootprint: [
        { workKey: 'sonarr:1:s1', episodeIds: [1001, 1002] },
        { workKey: 'sonarr:1:s2', episodeIds: [2001, 2002] },
      ],
      capture: [{ workKey: 'sonarr:1:s1', episodeIds: [1001, 1002] }],
    });

    const explicit = check('Some Show S01E02 Complete Series', original);
    expect(explicit).toMatchObject({
      kind: 'covered',
      requestedFootprint: [{ workKey: 'sonarr:1:s1', episodeIds: [1002], basis: 'explicit-episodes' }],
      capture: [{ workKey: 'sonarr:1:s1', episodeIds: [1002], basis: 'explicit-episodes' }],
    });
  });

  it('does not treat plain Complete as whole series or inferred coverage', () => {
    expect(check('Some Show Complete', [tvUnit(1, [1, 2])])).toEqual({
      kind: 'no-map', reason: 'no-map',
    });
  });

  it('maps precise anime absolute episodes across supplied seasons', () => {
    const units = [
      animeUnit(1, [{ episodeNumber: 1, absoluteEpisodeNumber: 101 }]),
      animeUnit(2, [{ episodeNumber: 1, absoluteEpisodeNumber: 102 }]),
    ];
    expect(check('Anime - 101-102', units)).toMatchObject({
      kind: 'covered',
      requestedFootprint: [
        { workKey: 'sonarr:1:s1', episodeIds: [1001], basis: 'explicit-episodes' },
        { workKey: 'sonarr:1:s2', episodeIds: [2001], basis: 'explicit-episodes' },
      ],
    });
  });

  it('keeps a known mismatching season restrictive even when an anime absolute number intersects', () => {
    const units = [animeUnit(1, [{ episodeNumber: 1, absoluteEpisodeNumber: 101 }])];
    expect(check('Anime S03 - 101', units)).toEqual({ kind: 'no-map', reason: 'no-map' });
  });

  it('maps unqualified E-only syntax as an exact subset, never as a season pack', () => {
    expect(check('Some Show - E02', [tvUnit(1, [1, 2, 3])])).toMatchObject({
      kind: 'covered',
      requestedFootprint: [{ workKey: 'sonarr:1:s1', episodeIds: [1002], basis: 'explicit-episodes' }],
      capture: [{ workKey: 'sonarr:1:s1', episodeIds: [1002], basis: 'explicit-episodes' }],
    });
  });

  it('keeps explicit malformed parser evidence terminal and does not permit an actionable expansion', () => {
    for (const title of [
      'Some Show S01Ebad - 07',
      'Some Show S01E02-Ebad - 07',
      'Some Show (S01E02 - 07',
      'Some Show S01E02 S02Ebad - 07',
    ]) {
      expect(check(title, [tvUnit(1, [2])])).toEqual({ kind: 'invalid', reason: 'invalid' });
    }
  });

  it('rejects structurally mixed movie and TV groups without making identity decisions', () => {
    const movie: WorkUnit = {
      key: 'radarr:5', kind: 'movie', arr: 'radarr', serviceId: 5, externalId: 42,
      title: 'Some Movie', altTitles: [],
    };
    expect(check('Some Show S01E02', [movie, tvUnit(1, [2])])).toEqual({ kind: 'invalid', reason: 'invalid' });
  });
});
