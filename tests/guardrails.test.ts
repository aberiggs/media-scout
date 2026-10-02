import { describe, expect, it } from 'vitest';
import { parseReleaseCoverage, parseReleaseTitle, type ParsedTitle } from '../src/core/parser';
import { isGrabbable, verifyGroupCoverage, verifyRelease } from '../src/core/guardrails';
import type { WorkUnit } from '../src/core/watcher';
import type { Release } from '../src/types/prowlarr';
import { releaseSchema } from '../src/types/prowlarr';

// --- fixtures ---------------------------------------------------------------

function release(overrides: Partial<Release> = {}): Release {
  return releaseSchema.parse({
    guid: 'guid-1',
    age: 3600,
    size: 2 * 1024 * 1024 * 1024,
    files: null,
    grabs: null,
    indexerId: 7,
    indexer: 'test-indexer',
    subGroup: null,
    title: 'Test Release',
    tvdbId: null,
    tmdbId: null,
    publishDate: '2026-01-01T00:00:00Z',
    downloadUrl: null,
    indexerFlags: [],
    categories: [],
    magnetUrl: 'magnet:?xt=urn:btih:abc',
    infoHash: 'abc',
    seeders: 10,
    leechers: 1,
    protocol: 'torrent',
    downloadClientId: null,
    ...overrides,
  });
}

function tvUnit(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    key: 'sonarr:1:s1',
    kind: 'tv',
    arr: 'sonarr',
    serviceId: 1,
    externalId: 100,
    title: 'Some Show',
    altTitles: [],
    seriesType: 'standard',
    season: {
      seasonNumber: 1,
      missing: [
        { episodeId: 101, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'Ep Seven' },
        { episodeId: 102, episodeNumber: 8, absoluteEpisodeNumber: 8, title: 'Ep Eight' },
        { episodeId: 103, episodeNumber: 9, absoluteEpisodeNumber: 9, title: 'Ep Nine' },
      ],
    },
    ...overrides,
  };
}

const animeUnit = () =>
  tvUnit({ key: 'sonarr:2:s1', seriesType: 'anime', title: 'SubsPlease Show' });

const parsed = (p: Partial<ParsedTitle>): ParsedTitle => ({
  season: null,
  seasonEpisodes: null,
  absoluteEpisodes: null,
  ...p,
});

const movieUnit = (): WorkUnit => ({
  key: 'radarr:5',
  kind: 'movie',
  arr: 'radarr',
  serviceId: 5,
  externalId: 42,
  title: 'Some Movie',
  altTitles: [],
});

const movieParsed: ParsedTitle = {
  season: null,
  seasonEpisodes: null,
  absoluteEpisodes: null,
};

// --- TV / anime: absolute matching -----------------------------------------

describe('verifyRelease — anime absolute', () => {
  it('positive absolute intersection maps missing episodes', () => {
    const result = verifyRelease({
      unit: animeUnit(),
      release: release(),
      parsed: parsed({ absoluteEpisodes: [7, 8] }),
    });
    expect(result).toEqual({
      ok: true,
      kind: 'tv',
      coverageBasis: 'explicit-episodes',
      covered: [
        { episodeId: 101, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'Ep Seven' },
        { episodeId: 102, episodeNumber: 8, absoluteEpisodeNumber: 8, title: 'Ep Eight' },
      ],
    });
  });

  it('mixed-numbering fallback: seasonEpisodes with matching season covers by episodeNumber', () => {
    const result = verifyRelease({
      unit: animeUnit(),
      release: release(),
      parsed: parsed({ season: 1, seasonEpisodes: [5] }),
    });
    // missing in this fixture has abs 7-9; episodeNumber 5 must come from a different missing row
    const unit = animeUnit();
    unit.season!.missing = [
      { episodeId: 201, episodeNumber: 5, absoluteEpisodeNumber: 7, title: 'Ep Five' },
      { episodeId: 202, episodeNumber: 8, absoluteEpisodeNumber: 8, title: 'Ep Eight' },
    ];
    const result2 = verifyRelease({
      unit,
      release: release(),
      parsed: parsed({ season: 1, seasonEpisodes: [5] }),
    });
    expect(result2).toEqual({
      ok: true,
      kind: 'tv',
      coverageBasis: 'explicit-episodes',
      covered: [
        { episodeId: 201, episodeNumber: 5, absoluteEpisodeNumber: 7, title: 'Ep Five' },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('mixed-numbering fallback covers an entry with absoluteEpisodeNumber null (TVDB-unmapped)', () => {
    const unit = animeUnit();
    unit.season!.missing = [
      { episodeId: 301, episodeNumber: 5, absoluteEpisodeNumber: null, title: 'Ep Five' },
      { episodeId: 302, episodeNumber: 8, absoluteEpisodeNumber: 8, title: 'Ep Eight' },
    ];
    const result = verifyRelease({
      unit,
      release: release(),
      parsed: parsed({ season: 1, seasonEpisodes: [5] }),
    });
    expect(result).toEqual({
      ok: true,
      kind: 'tv',
      coverageBasis: 'explicit-episodes',
      covered: [
        { episodeId: 301, episodeNumber: 5, absoluteEpisodeNumber: null, title: 'Ep Five' },
      ],
    });
  });

  it('empty intersection after all modes → no-episode-map', () => {
    const result = verifyRelease({
      unit: animeUnit(),
      release: release(),
      parsed: parsed({ absoluteEpisodes: [99] }),
    });
    expect(result).toEqual({ ok: false, reason: 'no-episode-map' });
  });
});

// --- TV / standard + daily ---------------------------------------------------

describe('verifyRelease — standard/daily', () => {
  it('season match + missing episode → ok with coverage', () => {
    const result = verifyRelease({
      unit: tvUnit(),
      release: release(),
      parsed: parsed({ season: 1, seasonEpisodes: [7, 8] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'tv') {
      expect(result.coverageBasis).toBe('explicit-episodes');
      expect(result.covered.map((c) => c.episodeNumber)).toEqual([7, 8]);
    }
  });

  it('season mismatch → season-mismatch', () => {
    const result = verifyRelease({
      unit: tvUnit(),
      release: release(),
      parsed: parsed({ season: 2, seasonEpisodes: [7] }),
    });
    expect(result).toEqual({ ok: false, reason: 'season-mismatch' });
  });

  it('zero overlap → no-episode-map', () => {
    const result = verifyRelease({
      unit: tvUnit(),
      release: release(),
      parsed: parsed({ season: 1, seasonEpisodes: [1, 2] }),
    });
    expect(result).toEqual({ ok: false, reason: 'no-episode-map' });
  });

  it('daily behaves like standard', () => {
    const result = verifyRelease({
      unit: tvUnit({ seriesType: 'daily' }),
      release: release(),
      parsed: parsed({ season: 1, seasonEpisodes: [9] }),
    });
    expect(result.ok).toBe(true);
  });

  it('season 0 specials match by strict equality, not truthiness', () => {
    const unit = tvUnit({ key: 'sonarr:1:s0' });
    unit.season!.seasonNumber = 0;
    unit.season!.missing = [
      { episodeId: 401, episodeNumber: 1, absoluteEpisodeNumber: 1, title: 'Special One' },
    ];
    const result = verifyRelease({
      unit,
      release: release(),
      parsed: parsed({ season: 0, seasonEpisodes: [1] }),
    });
    expect(result.ok).toBe(true);
  });

  it('E-only parse shape (null season) on standard → season-mismatch, not unparseable', () => {
    const result = verifyRelease({
      unit: tvUnit(),
      release: release(),
      parsed: parsed({ seasonEpisodes: [7] }),
    });
    expect(result).toEqual({ ok: false, reason: 'season-mismatch' });
  });
});

describe('verifyRelease — inferred season packs', () => {
  it('matching season-only claim covers exactly the missing set and labels it inferred', () => {
    const result = verifyRelease({
      unit: tvUnit(),
      release: release(),
      parsed: parsed({ season: 1, seasonPack: true }),
    });
    expect(result).toEqual({
      ok: true,
      kind: 'tv',
      coverageBasis: 'inferred-season-pack',
      covered: [
        { episodeId: 101, episodeNumber: 7, absoluteEpisodeNumber: 7, title: 'Ep Seven' },
        { episodeId: 102, episodeNumber: 8, absoluteEpisodeNumber: 8, title: 'Ep Eight' },
        { episodeId: 103, episodeNumber: 9, absoluteEpisodeNumber: 9, title: 'Ep Nine' },
      ],
    });
  });

  it('matching anime pack is inferred, but a known wrong season rejects absolute evidence first', () => {
    const matching = verifyRelease({
      unit: animeUnit(),
      release: release(),
      parsed: parsed({ season: 1, seasonPack: true }),
    });
    expect(matching).toMatchObject({
      ok: true,
      kind: 'tv',
      coverageBasis: 'inferred-season-pack',
      covered: [{ episodeNumber: 7 }, { episodeNumber: 8 }, { episodeNumber: 9 }],
    });

    const wrongSeason = verifyRelease({
      unit: animeUnit(),
      release: release(),
      parsed: parsed({ season: 2, absoluteEpisodes: [7] }),
    });
    expect(wrongSeason).toEqual({ ok: false, reason: 'season-mismatch' });
  });

  it('season-only claim cannot cover an empty missing set', () => {
    const unit = tvUnit();
    unit.season!.missing = [];
    expect(verifyRelease({
      unit,
      release: release(),
      parsed: parsed({ season: 1, seasonPack: true }),
    })).toEqual({ ok: false, reason: 'no-episode-map' });
  });

  it('explicit claims never fall back to a pack when they have no overlap', () => {
    expect(verifyRelease({
      unit: tvUnit(),
      release: release(),
      parsed: parsed({ season: 1, seasonEpisodes: [1, 2], seasonPack: true }),
    })).toEqual({ ok: false, reason: 'no-episode-map' });
  });
});

describe('verifyRelease — preserved explicit episode evidence', () => {
  it('parenthesized E02 remains precise against a larger missing set', () => {
    const unit = tvUnit();
    unit.season!.missing = [2, 3, 7].map((episodeNumber) => ({
      episodeId: 500 + episodeNumber,
      episodeNumber,
      absoluteEpisodeNumber: null,
      title: `Ep ${episodeNumber}`,
    }));
    const result = verifyRelease({
      unit,
      release: release({ title: 'Show S01 (E02)1080p' }),
      parsed: parseReleaseTitle('Show S01 (E02)1080p'),
    });
    expect(result).toMatchObject({
      ok: true,
      kind: 'tv',
      coverageBasis: 'explicit-episodes',
      covered: [{ episodeNumber: 2 }],
    });
  });

  it('season-qualified E02 does not match missing season episode 1 even when its absolute number is 2', () => {
    const unit = animeUnit();
    unit.season!.missing = [
      { episodeId: 601, episodeNumber: 1, absoluteEpisodeNumber: 2, title: 'Absolute Two, Season Episode One' },
    ];
    const parsedTitle = 'Show (Season1 Episode2)1080p';
    expect(verifyRelease({
      unit,
      release: release({ title: parsedTitle }),
      parsed: parseReleaseTitle(parsedTitle),
    })).toEqual({ ok: false, reason: 'no-episode-map' });
  });

  it('valid wrapped episode ranges stay precise with release metadata attached', () => {
    const unit = tvUnit();
    unit.season!.missing = [2, 3, 7].map((episodeNumber) => ({
      episodeId: 700 + episodeNumber,
      episodeNumber,
      absoluteEpisodeNumber: null,
      title: `Ep ${episodeNumber}`,
    }));
    const title = 'Show S01(E02-E03) 1080p.x265-GROUP';
    expect(verifyRelease({
      unit,
      release: release({ title }),
      parsed: parseReleaseTitle(title),
    })).toMatchObject({
      ok: true,
      kind: 'tv',
      coverageBasis: 'explicit-episodes',
      covered: [{ episodeNumber: 2 }, { episodeNumber: 3 }],
    });
  });

  it('malformed explicit evidence attached to a valid season label cannot infer a pack', () => {
    const title = 'Show S01 Complete S01Ebad - 07';
    expect(verifyRelease({
      unit: tvUnit(),
      release: release({ title }),
      parsed: parseReleaseTitle(title),
    })).toEqual({ ok: false, reason: 'unparseable' });
  });
});

// --- unparseable -------------------------------------------------------------

describe('verifyRelease — unparseable', () => {
  it('all-null parsed on TV → unparseable', () => {
    const result = verifyRelease({
      unit: tvUnit(),
      release: release(),
      parsed: parsed({}),
    });
    expect(result).toEqual({ ok: false, reason: 'unparseable' });
  });
});

// --- movies (D2: identity AND quality are the picker LLM's judgment) ---------

describe('verifyRelease — movie', () => {
  it('movie → ok regardless of tmdbId or title evidence (null tmdbId, unrelated title)', () => {
    const result = verifyRelease({
      unit: movieUnit(),
      release: release({ tmdbId: null, title: 'Completely.Unrelated.Pack.2022' }),
      parsed: movieParsed,
    });
    expect(result).toEqual({ ok: true, kind: 'movie' });
  });

  it('movie → ok even when tmdbId conflicts and size is null (LLM weighs the unknowns)', () => {
    const result = verifyRelease({
      unit: movieUnit(),
      release: release({ tmdbId: 999, size: null }),
      parsed: movieParsed,
    });
    expect(result).toEqual({ ok: true, kind: 'movie' });
  });
});

describe('verifyGroupCoverage — movie and authorization boundaries', () => {
  it('preserves the movie identity/quality boundary and captures only caller-supplied movie work', () => {
    const movie = movieUnit();
    expect(verifyGroupCoverage({
      originalUnits: [movie],
      actionableUnits: [movie],
      parsed: parseReleaseCoverage('unparseable unrelated release'),
    })).toEqual({
      kind: 'covered',
      requestedFootprint: [{ workKey: movie.key, episodeIds: null, basis: null }],
      capture: [{ workKey: movie.key, episodeIds: null, basis: null }],
      extraSeasons: [],
    });
  });

  it('does not promote TV coverage when the caller supplies no authorized actionable targets', () => {
    expect(verifyGroupCoverage({
      originalUnits: [tvUnit()],
      actionableUnits: [],
      parsed: parseReleaseCoverage('Some Show S01 Complete'),
    })).toEqual({ kind: 'no-map', reason: 'no-map' });
  });
});

// --- covered dedup -----------------------------------------------------------

describe('verifyRelease — covered dedup', () => {
  it('duplicate episode numbers appear once', () => {
    const result = verifyRelease({
      unit: animeUnit(),
      release: release(),
      parsed: parsed({ absoluteEpisodes: [7, 7, 8] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'tv') {
      expect(result.covered.map((c) => c.episodeNumber)).toEqual([7, 8]);
    }
  });
});

// --- isGrabbable (Q2) --------------------------------------------------------

describe('isGrabbable', () => {
  it('magnetUrl only → true', () => {
    expect(isGrabbable(release({ magnetUrl: 'magnet:?xt=urn:btih:abc', downloadUrl: null }))).toBe(true);
  });
  it('downloadUrl only → true', () => {
    expect(isGrabbable(release({ magnetUrl: null, downloadUrl: 'https://dl.test/x' }))).toBe(true);
  });
  it('both null → false', () => {
    expect(isGrabbable(release({ magnetUrl: null, downloadUrl: null }))).toBe(false);
  });
});
