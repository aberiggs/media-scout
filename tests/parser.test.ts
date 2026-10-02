import { describe, expect, it } from 'vitest';
import { parseReleaseCoverage, parseReleaseTitle, type ParsedTitle } from '../src/core/parser.js';

const rows: Array<{ title: string; expected: ParsedTitle }> = [
  // --- required rows ---
  { title: "[SubsPlease] Frieren - Beyond Journey's End - 07 (1080p) [B7C4E4A8].mkv", expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [7] } },
  { title: '[SubsPlease] Title - 01-12 (1080p)', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } },
  { title: 'Show.Name.S01E05.720p.BluRay.x264-GROUP', expected: { season: 1, seasonEpisodes: [5], absoluteEpisodes: null } },
  { title: 'Show.S01E01-E03.1080p', expected: { season: 1, seasonEpisodes: [1, 2, 3], absoluteEpisodes: null } },
  { title: 'Show.S01E01E02', expected: { season: 1, seasonEpisodes: [1, 2], absoluteEpisodes: null } },
  { title: 'One Piece - 1017 [1080p]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [1017] } },
  { title: 'Show.S02E03v2.1080p', expected: { season: 2, seasonEpisodes: [3], absoluteEpisodes: null } },
  { title: 'Show - E05', expected: { season: null, seasonEpisodes: [5], absoluteEpisodes: null } },
  { title: 'Show - E01-E03', expected: { season: null, seasonEpisodes: [1, 2, 3], absoluteEpisodes: null } },
  { title: 'Movie.Name.2019.1080p', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show.2023.10.20.1080p', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show 2160p 10bit 5.1 x265', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: '[Group] Title 2.0 - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [7] } },
  { title: 'Title - 1080', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Random.Text.Here', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  // --- gaps discovered while implementing ---
  { title: 'show.s01e05.720p', expected: { season: 1, seasonEpisodes: [5], absoluteEpisodes: null } },
  { title: 'Show - e05', expected: { season: null, seasonEpisodes: [5], absoluteEpisodes: null } },
  { title: 'Show - E12-E15', expected: { season: null, seasonEpisodes: [12, 13, 14, 15], absoluteEpisodes: null } },
  { title: 'Anime - 101-105 [1080p]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [101, 102, 103, 104, 105] } },
  { title: 'Show - 07 [GROUP] [abc123ff]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [7] } },
  { title: 'Show.S01E05-E07', expected: { season: 1, seasonEpisodes: [5, 6, 7], absoluteEpisodes: null } },
  { title: 'Show.S01E01E02E03.1080p', expected: { season: 1, seasonEpisodes: [1, 2, 3], absoluteEpisodes: null } },
  { title: 'Show 23.976fps - 04', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [4] } },
  { title: 'Show 8-bit - 03', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [3] } },
  { title: 'Show 10bit - 03', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [3] } },
  { title: 'Show.2023-10-20.1080p', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show.5.1.720p.x264-GROUP', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show - E05v2', expected: { season: null, seasonEpisodes: [5], absoluteEpisodes: null } },
  { title: 'Show - 2023 - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [7] } },
  { title: 'Show.S01E05.v2.1080p', expected: { season: 1, seasonEpisodes: [5], absoluteEpisodes: null } },
  // F1: rejected SxxEyy chain must short-circuit to all-null, never re-match as E/absolute
  { title: 'Show.S01E05-E02.1080p', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show.S01E24-E01.1080p', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show.S01E05-E999.1080p', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  // F2: ordinal/decorative numbers are not episodes
  { title: 'Kill.Bill.Vol.2.2004.1080p.BluRay.x264', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Harry.Potter...Part.2.2011.1080p', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'John.Wick.Chapter.4.2023.2160p', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Season 2 Episode 5 Show', expected: { season: 2, seasonEpisodes: [5], absoluteEpisodes: null } },
  { title: 'Attack on Titan Final Season Part 2 - 07 [1080p]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [7] } },
  // R3: hyphenated ordinal ranges must strip BOTH endpoints, not leave a dangling number
  { title: 'Show - Part 1-3 Complete [1080p]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Naruto - Vol 1-12 Complete Collection [1080p]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show - Book 1-3 Omnibus [1080p]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Attack on Titan - Chapter 1-4 Compilation [1080p]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  // F3: glued revision suffix on bare absolute
  { title: '[SubsPlease] Title - 07v2 (1080p).mkv', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [7] } },
  { title: 'Title - 07v2', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [7] } },
  // F4d: range END landing on a resolution number poisons the whole range
  { title: 'Show - 1070-1080 [GROUP]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  // F5: overlapping/duplicate absolute matches — sorted, deduped
  { title: 'Show - 01-12 - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } },
  { title: 'Show - 07 - 01-05', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: [1, 2, 3, 4, 5, 7] } },
  // F4b: reversed bare absolute range asserted as all-null
  { title: 'Show - 12-01', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  // Single, well-delimited season-only pack labels are inferred, not episodes.
  { title: 'Fear The Walking Dead S01 1080p x265 [jlw]', expected: { season: 1, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  { title: 'Fear the Walking Dead (Season 06)', expected: { season: 6, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  { title: 'Show Season.1 Complete 2160p x265', expected: { season: 1, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  { title: 'Show season 02 10bit BluRay', expected: { season: 2, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  // Season labels are removed before absolute scans; unrelated numeric tokens do not create episodes.
  { title: 'Show S01 Complete 1080p x265', expected: { season: 1, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  { title: 'Show S01-S03 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show Season 1-3 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01S02 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 Season 02 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show Season 1 Part 2 Complete', expected: { season: 1, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  { title: 'Show Part 2 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  // Explicit episode evidence is preserved and never upgraded to a season pack.
  { title: 'Show S01E02 Complete', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show Season 1 E02 Complete', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S02 - 101 [1080p]', expected: { season: 2, seasonEpisodes: null, absoluteEpisodes: [101] } },
  { title: 'Show S01E05-E02 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show Season 1 - 12-01 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show Season 1-3 E02 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  // Tight token boundaries avoid interpreting words like S01E02ish / Season 123 as claims.
  { title: 'Show S01E02ish Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show Season 123 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  // Partial labels and explicit episode syntax that cannot be parsed completely never become packs.
  { title: 'Show S01E 1080p', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01Ebad', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01junk', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01/02 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01,02 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01;02 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show Season 1–3 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show Season 1—3 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  // Raw episode evidence survives parentheses and dotted resolution cleanup.
  { title: 'Show S01 (E02)1080p', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show (Season1 Episode2)1080p', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show Season1 Episode2.720p', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  // Raw-grammar regressions: explicit claims are terminal, complete tokens only.
  { title: 'Show S01-Ebad', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01E02-Ebad', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 E 02', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01(E02-E03)', expected: { season: 1, seasonEpisodes: [2, 3], absoluteEpisodes: null } },
  { title: 'Show S01[E02-E03]', expected: { season: 1, seasonEpisodes: [2, 3], absoluteEpisodes: null } },
  { title: 'Show S01(E02-E01)', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01(E02v2)', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show (S01E02)', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show (Episode2)', expected: { season: null, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show (E02-E03)', expected: { season: null, seasonEpisodes: [2, 3], absoluteEpisodes: null } },
  { title: 'Show (E02-E01)', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show [E02v2]', expected: { season: null, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01E02 1080p.720p.x265-GROUP', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01E02-E03Ebad - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01E02E03-E04', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01(E02-E01) - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show E02ish - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show E1234 - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show E02v123 - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show (E02-Ebad)', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show (E1234) - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show [E02v123] - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'ÉShowS01 Complete', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01E02 S02Ebad - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 Complete S01Ebad - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 (E02-E03 - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 (S01 (E02)) - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 [07] Complete', expected: { season: 1, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  { title: 'Show Season 0 Complete', expected: { season: 0, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  { title: 'Show_S01_Complete', expected: { season: 1, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  { title: 'Show_Season.1_Complete', expected: { season: 1, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  // Wrapper detection and actual parsing share all atom separators and token rules.
  { title: 'Show S01 E_02', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01 [E_02]', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01 (E._\t 02)', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01 [E\t02v2]', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01 (E..__\t 02)', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01 [Episode_.\t02]', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01 E', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 Episode', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 [E_]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 E_foo', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 [E_foo]', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 (Episode_)', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01 Extended', expected: { season: 1, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  { title: 'Show S01 Episode Guide Complete', expected: { season: 1, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true } },
  { title: 'Show S01 (E02) Complete 1080p', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  // A hyphen-connected claim cannot be split across metadata containers and re-read as siblings.
  { title: 'Show S01(E03)-(E02) - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01E03-[E02] - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01(E03)-E02 - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01(E03) - E02 - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01(E03)–[E02] - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01[E03]-(E02) - 07', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show (S01E02)-Ebad', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show [S01E02]-Ebad', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show (S01E02)-E', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show [S01E02]-Episode', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show (S01E02)-E_', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show [S01E02]-E_02bad', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show (S01E02)-E1234', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show [S01E02]-E02v123', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01E02-E', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01E02-Episode', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01E02-E_', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01E02-E_02bad', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01E02-E1234', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show S01E02-E02v123', expected: { season: null, seasonEpisodes: null, absoluteEpisodes: null } },
  { title: 'Show (S01E02)-GROUP', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show [S01E02]-WEB-DL', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01E02-GROUP', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show S01E02-WEB-DL', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
  { title: 'Show (S01E02)-Episode Guide', expected: { season: 1, seasonEpisodes: [2], absoluteEpisodes: null } },
];

describe('parseReleaseTitle', () => {
  it.each(rows)('$title', ({ title, expected }) => {
    expect(parseReleaseTitle(title)).toEqual(expected);
  });
});

describe('parseReleaseCoverage', () => {
  it.each([
    ['Show S01-S02 Complete', { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: null }, { seasonNumber: 2, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false }],
    ['Show S01S02 Complete', { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: null }, { seasonNumber: 2, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false }],
    ['Show S01 S02 Complete', { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: null }, { seasonNumber: 2, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false }],
    ['Show Seasons1-2 Complete', { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: null }, { seasonNumber: 2, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false }],
    ['Show Season1-2 Complete', { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: null }, { seasonNumber: 2, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false }],
    ['Show S01E02 S02E03', { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: [2] }, { seasonNumber: 2, episodes: [3] }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false }],
    ['Show Complete Series', { kind: 'claims', seasonClaims: [], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: true }],
    ['Show All Seasons', { kind: 'claims', seasonClaims: [], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: true }],
    ['Show S01E02 Complete Series', { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: [2] }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false }],
    ['Show S01 [E_02]', { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: [2] }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false }],
    ['Show S01 [E_]', { kind: 'invalid' }],
    ['Show S01 [E_02bad]', { kind: 'invalid' }],
    ['Show (S01E02-Ebad)', { kind: 'invalid' }],
    ['Show Complete', { kind: 'none' }],
    ['Show S01-S03E02 Complete', { kind: 'invalid' }],
    ['Show S01E02 S02Ebad - 07', { kind: 'invalid' }],
    ['Show S01E02-Ebad - 07', { kind: 'invalid' }],
    ['Show (S01E02 - 07', { kind: 'invalid' }],
  ] as const)('%s retains bounded raw claim evidence', (title, expected) => {
    expect(parseReleaseCoverage(title)).toEqual(expected);
  });

  it('keeps anime absolute ranges distinct when there are no season-qualified claims', () => {
    expect(parseReleaseCoverage('Anime - 101-102')).toEqual({
      kind: 'claims',
      seasonClaims: [],
      absoluteEpisodes: [101, 102],
      unqualifiedEpisodes: null,
      wholeSeries: false,
    });
  });

  it('keeps compatibility parsing all-null for multi-season claims', () => {
    expect(parseReleaseTitle('Show S01E02 S02E03')).toEqual({
      season: null,
      seasonEpisodes: null,
      absoluteEpisodes: null,
    });
  });
});
