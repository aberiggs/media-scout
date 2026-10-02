import type { ParsedReleaseCoverage } from './group-types';
export type { ParsedReleaseCoverage } from './group-types';

export interface ParsedTitle {
  /** Season number from a complete season label; null when absent. */
  season: number | null;
  /** Explicit season/episode or E-only claims, with ranges expanded. */
  seasonEpisodes: number[] | null;
  /** Absolute episode numbers from bare/range forms (anime absolute numbering); null when absent. */
  absoluteEpisodes: number[] | null;
  /** Present only when a single unambiguous season-only pack label was parsed. */
  seasonPack?: true;
}

type RawEvidence =
  | { kind: 'invalid' }
  | { kind: 'none' }
  | {
      kind: 'claims';
      seasonClaims: Array<{ seasonNumber: number; episodes: number[] | null }>;
      absoluteEpisodes: number[] | null;
      unqualifiedEpisodes: number[] | null;
      wholeSeries: boolean;
    };

interface SeasonLabel {
  season: number;
  start: number;
  end: number;
  wordForm: boolean;
}

interface EpisodeClaim {
  episodes: number[];
  end: number;
}

interface EpisodeMarker {
  wordForm: boolean;
  numberStart: number;
}

type LabelRead = { kind: 'none' } | { kind: 'invalid' } | { kind: 'label'; label: SeasonLabel };
type EpisodeRead = { kind: 'none' } | { kind: 'invalid' } | { kind: 'claim'; claim: EpisodeClaim };
type EpisodeContinuation = 'claim' | 'invalid' | 'none';

interface ClaimScan {
  invalid: boolean;
  seasons: number[];
  episodes: number[];
  seasonClaims: Array<{ seasonNumber: number; episodes: number[] | null }>;
  unqualifiedEpisodes: number[];
  remainder: string;
}

interface BlockScan {
  invalid: boolean;
  topLevel: string;
  seasons: number[];
  episodes: number[];
  seasonClaims: Array<{ seasonNumber: number; episodes: number[] | null }>;
  unqualifiedEpisodes: number[];
}

/** Extract claims before any sanitizer can erase marker syntax or its number boundaries. */
export function parseReleaseTitle(title: string): ParsedTitle {
  const allNull: ParsedTitle = { season: null, seasonEpisodes: null, absoluteEpisodes: null };
  const raw = extractRawEvidence(title);
  if (raw.kind === 'invalid') return allNull;
  if (raw.kind === 'none' || raw.wholeSeries) return allNull;
  if (raw.seasonClaims.length > 1) return allNull;
  const claim = raw.seasonClaims[0];
  if (claim?.episodes !== null && claim?.episodes !== undefined) {
    return { season: claim.seasonNumber, seasonEpisodes: claim.episodes, absoluteEpisodes: null };
  }
  if (raw.unqualifiedEpisodes !== null) {
    return { season: null, seasonEpisodes: raw.unqualifiedEpisodes, absoluteEpisodes: null };
  }
  if (raw.absoluteEpisodes !== null) {
    return { season: claim?.seasonNumber ?? null, seasonEpisodes: null, absoluteEpisodes: raw.absoluteEpisodes };
  }
  if (claim) return { season: claim.seasonNumber, seasonEpisodes: null, absoluteEpisodes: null, seasonPack: true };
  return allNull;
}

/** Parse bounded raw coverage evidence without flattening season/episode associations. */
export function parseReleaseCoverage(title: string): ParsedReleaseCoverage {
  const raw = extractRawEvidence(title);
  if (raw.kind === 'invalid') return { kind: 'invalid' };
  if (raw.kind === 'none') return { kind: 'none' };
  return {
    kind: 'claims',
    seasonClaims: raw.seasonClaims,
    absoluteEpisodes: raw.absoluteEpisodes,
    unqualifiedEpisodes: raw.unqualifiedEpisodes,
    wholeSeries: raw.wholeSeries,
  };
}

function hasWholeSeriesMarker(title: string): boolean {
  return /(?:^|[^\p{L}\p{N}_])(?:complete[\s._-]+series|all[\s._-]+seasons)(?=$|[^\p{L}\p{N}_])/iu.test(title);
}

function extractRawEvidence(title: string): RawEvidence {
  const blocks = isolateBlocks(title);
  if (blocks.invalid) return { kind: 'invalid' };
  const outside = scanClaimText(blocks.topLevel, false);
  if (outside.invalid) return { kind: 'invalid' };

  const mergedSeasonClaims = mergeSeasonClaims([...blocks.seasonClaims, ...outside.seasonClaims]);
  if (mergedSeasonClaims === null) return { kind: 'invalid' };
  let seasonClaims = mergedSeasonClaims;
  let unqualifiedEpisodes = uniqueSorted([...blocks.unqualifiedEpisodes, ...outside.unqualifiedEpisodes]);
  if (seasonClaims.length === 1 && unqualifiedEpisodes.length > 0) {
    const [onlySeason] = seasonClaims;
    seasonClaims = [{
      seasonNumber: onlySeason!.seasonNumber,
      episodes: uniqueSorted([...(onlySeason!.episodes ?? []), ...unqualifiedEpisodes]),
    }];
    unqualifiedEpisodes = [];
  }
  const sanitized = sanitize(outside.remainder);
  if (hasRejectedAbsoluteRange(sanitized)) return { kind: 'invalid' };
  const absoluteEpisodes = matchAbsolute(sanitized);
  const hasNumericEvidence = seasonClaims.length > 0 || unqualifiedEpisodes.length > 0 || absoluteEpisodes !== null;
  const wholeSeries = !hasNumericEvidence && hasWholeSeriesMarker(title);
  if (!hasNumericEvidence && !wholeSeries) return { kind: 'none' };
  return {
    kind: 'claims',
    seasonClaims,
    absoluteEpisodes,
    unqualifiedEpisodes: unqualifiedEpisodes.length ? unqualifiedEpisodes : null,
    wholeSeries,
  };
}

function mergeSeasonClaims(
  claims: Array<{ seasonNumber: number; episodes: number[] | null }>,
): Array<{ seasonNumber: number; episodes: number[] | null }> | null {
  const bySeason = new Map<number, number[] | null>();
  for (const claim of claims) {
    if (!bySeason.has(claim.seasonNumber)) {
      bySeason.set(claim.seasonNumber, claim.episodes === null ? null : [...claim.episodes]);
      continue;
    }
    const previous = bySeason.get(claim.seasonNumber)!;
    if (previous === null || claim.episodes === null) return null;
    bySeason.set(claim.seasonNumber, [...previous, ...claim.episodes]);
  }
  return [...bySeason.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNumber, episodes]) => ({
      seasonNumber,
      episodes: episodes === null ? null : uniqueSorted(episodes),
    }));
}

function uniqueSorted(numbers: number[]): number[] {
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** Marker-bearing containers must be a complete supported claim; ordinary release tags stay metadata. */
function isolateBlocks(title: string): BlockScan {
  const seasons: number[] = [];
  const episodes: number[] = [];
  const seasonClaims: Array<{ seasonNumber: number; episodes: number[] | null }> = [];
  const unqualifiedEpisodes: number[] = [];
  const codeUnitChars = title.split('');

  for (let i = 0; i < title.length; i++) {
    const open = title[i];
    if (open !== '(' && open !== '[') {
      if (open === ')' || open === ']') {
        if (hasClaimMarker(title)) return invalidBlocks(title);
      }
      continue;
    }

    const block = findBlock(title, i);
    const bodyEnd = block.end < 0 ? title.length : block.end;
    const body = title.slice(i + 1, bodyEnd);
    const markerBearing = hasClaimMarker(body);
    if ((block.nested || block.end < 0 || block.mismatched) && markerBearing) {
      return invalidBlocks(title);
    }

    let parsedBlock: ClaimScan | null = null;
    if (markerBearing) {
      const parsed = scanClaimText(body, true);
      if (parsed.invalid || !isOnlyClaimSeparators(parsed.remainder)) {
        return invalidBlocks(title);
      }
      parsedBlock = parsed;
      seasons.push(...parsed.seasons);
      episodes.push(...parsed.episodes);
      seasonClaims.push(...parsed.seasonClaims);
      unqualifiedEpisodes.push(...parsed.unqualifiedEpisodes);
    }
    if (hasCrossContainerEpisodeRange(
      title,
      i,
      block.end,
      (parsedBlock?.episodes.length ?? 0) > 0,
      hasEpisodeAttemptAtBlockBody(body),
    )) return invalidBlocks(title);

    const end = block.end < 0 ? title.length - 1 : block.end;
    for (let j = i; j <= end; j++) codeUnitChars[j] = ' ';
    i = end;
  }

  return { invalid: false, topLevel: codeUnitChars.join(''), seasons, episodes, seasonClaims, unqualifiedEpisodes };
}

function invalidBlocks(title: string): BlockScan {
  return { invalid: true, topLevel: title, seasons: [], episodes: [], seasonClaims: [], unqualifiedEpisodes: [] };
}

function findBlock(title: string, start: number): { end: number; nested: boolean; mismatched: boolean } {
  const expected: string[] = [title[start] === '(' ? ')' : ']'];
  let nested = false;
  for (let i = start + 1; i < title.length; i++) {
    const char = title[i];
    if (char === '(' || char === '[') {
      nested = true;
      expected.push(char === '(' ? ')' : ']');
    } else if (char === ')' || char === ']') {
      if (expected.at(-1) !== char) return { end: i, nested, mismatched: true };
      expected.pop();
      if (expected.length === 0) return { end: i, nested, mismatched: false };
    }
  }
  return { end: -1, nested, mismatched: false };
}

function hasClaimMarker(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const season = readSeasonLabel(text, index);
    if (season.kind !== 'none' || isSeasonWordMarkerAt(text, index)) return true;
    if (isTokenBoundaryBefore(text, index) && readEpisodeMarker(text, index) !== null) return true;
  }
  return false;
}

function isSeasonWordMarkerAt(text: string, index: number): boolean {
  if (!isTokenBoundaryBefore(text, index) || text.slice(index, index + 6).toLowerCase() !== 'season') return false;
  return !isUnicodeLetterAt(text, index + 6);
}

function hasCrossContainerEpisodeRange(
  title: string,
  blockStart: number,
  blockEnd: number,
  blockHasEpisodeClaim: boolean,
  blockHasEpisodeAttempt: boolean,
): boolean {
  if (!blockHasEpisodeClaim && !blockHasEpisodeAttempt) return false;
  let right = blockEnd + 1;
  while (isEpisodeChainSeparator(title[right])) right++;
  if (isEpisodeRangeDash(title[right])) {
    right++;
    while (isEpisodeChainSeparator(title[right])) right++;
    if (classifyEpisodeContinuation(title, right) !== 'none' || hasEpisodeAttemptBlockAt(title, right)) return true;
  }

  let left = blockStart - 1;
  while (isEpisodeChainSeparator(title[left])) left--;
  if (isEpisodeRangeDash(title[left])) {
    const prefix = scanClaimText(title.slice(0, left), false);
    if (prefix.invalid || prefix.episodes.length > 0) return true;
  }
  return false;
}

function hasEpisodeAttemptBlockAt(title: string, index: number): boolean {
  if (title[index] !== '(' && title[index] !== '[') return false;
  const block = findBlock(title, index);
  if (block.end < 0 || block.nested || block.mismatched) return false;
  const body = title.slice(index + 1, block.end);
  if (hasEpisodeAttemptAtBlockBody(body)) return true;
  if (!hasClaimMarker(body)) return false;
  const parsed = scanClaimText(body, true);
  return !parsed.invalid && parsed.episodes.length > 0 && isOnlyClaimSeparators(parsed.remainder);
}

function hasEpisodeAttemptAtBlockBody(body: string): boolean {
  let start = 0;
  while (isEpisodeChainSeparator(body[start])) start++;
  return classifyEpisodeContinuation(body, start) !== 'none';
}

function scanClaimText(text: string, strict: boolean): ClaimScan {
  const chars = text.split('');
  const seasons: number[] = [];
  const episodes: number[] = [];
  const seasonClaims: Array<{ seasonNumber: number; episodes: number[] | null }> = [];
  const unqualifiedEpisodes: number[] = [];

  for (let i = 0; i < text.length;) {
    const seasonRead = readSeasonLabel(text, i);
    if (seasonRead.kind === 'invalid') return invalidScan(text);
    if (seasonRead.kind === 'label') {
      const parsed = readSeasonClaim(text, seasonRead.label);
      if (parsed.kind === 'invalid') return invalidScan(text);
      seasons.push(...parsed.seasons);
      seasonClaims.push(...parsed.seasons.map((seasonNumber) => ({
        seasonNumber,
        episodes: parsed.seasons.length === 1 ? parsed.episodes : null,
      })));
      maskRange(chars, seasonRead.label.start, parsed.end);
      if (parsed.episodes !== null) episodes.push(...parsed.episodes);
      i = Math.max(i + 1, parsed.end);
      continue;
    }

    const explicitEpisode = isEpisodeSignalAt(text, i);
    if (explicitEpisode) {
      const parsed = readEpisodeClaim(text, i);
      if (parsed.kind !== 'claim') return invalidScan(text);
      episodes.push(...parsed.claim.episodes);
      unqualifiedEpisodes.push(...parsed.claim.episodes);
      maskRange(chars, i, parsed.claim.end);
      i = parsed.claim.end;
      continue;
    }
    i++;
  }

  const remainder = chars.join('');
  if (strict && !isOnlyClaimSeparators(remainder)) return invalidScan(text);
  return { invalid: false, seasons, episodes, seasonClaims, unqualifiedEpisodes, remainder };
}

function invalidScan(text: string): ClaimScan {
  return { invalid: true, seasons: [], episodes: [], seasonClaims: [], unqualifiedEpisodes: [], remainder: text };
}

function readSeasonLabel(text: string, index: number, allowAttached = false): LabelRead {
  if (!allowAttached && !isTokenBoundaryBefore(text, index)) return { kind: 'none' };
  const keyword = text.slice(index, index + 6).toLowerCase();
  const wordForm = keyword === 'season';
  const abbreviated = text[index]?.toLowerCase() === 's' && isAsciiDigit(text[index + 1]);
  if (!wordForm && !abbreviated) return { kind: 'none' };

  let cursor = index;
  if (wordForm) {
    cursor += 6;
    if (text[cursor]?.toLowerCase() === 's') cursor++;
    else if (isUnicodeLetterAt(text, cursor)) return { kind: 'none' };
    while (isSeasonSeparator(text[cursor])) cursor++;
  } else {
    cursor++;
  }
  const numberStart = cursor;
  while (isAsciiDigit(text[cursor])) cursor++;
  if (cursor === numberStart) return { kind: 'none' };
  if (cursor - numberStart > 2) return { kind: 'invalid' };
  return {
    kind: 'label',
    label: { season: parseInt(text.slice(numberStart, cursor), 10), start: index, end: cursor, wordForm },
  };
}

function readSeasonClaim(text: string, label: SeasonLabel):
  | { kind: 'claim'; seasons: number[]; episodes: number[] | null; end: number }
  | { kind: 'invalid' } {
  let cursor = label.end;
  while (isSeasonEpisodeSeparator(text[cursor])) cursor++;

  if (isEpisodeMarkerAt(text, cursor)) {
    const parsed = readEpisodeClaim(text, cursor);
    return parsed.kind === 'claim'
      ? { kind: 'claim', seasons: [label.season], episodes: parsed.claim.episodes, end: parsed.claim.end }
      : { kind: 'invalid' };
  }

  const seasons = [label.season];
  let end = label.end;
  let chained = false;
  for (;;) {
    let next = end;
    while (isSeasonEpisodeSeparator(text[next])) next++;
    let separator: 'range' | 'list' | 'adjacent' | null = null;
    if (isSeasonRangeDash(text[next])) {
      separator = 'range';
      next++;
      while (isSeasonEpisodeSeparator(text[next])) next++;
    } else if (isSeasonListSeparator(text[next])) {
      separator = 'list';
      next++;
      while (isSeasonEpisodeSeparator(text[next])) next++;
    } else if (next !== end || readSeasonLabel(text, next, true).kind === 'label') {
      separator = 'adjacent';
    }
    if (separator === null) break;

    const nextLabel = readSeasonLabel(text, next, separator === 'adjacent');
    let seasonNumber: number;
    let nextEnd: number;
    if (nextLabel.kind === 'label') {
      seasonNumber = nextLabel.label.season;
      nextEnd = nextLabel.label.end;
    } else if (isAsciiDigit(text[next])) {
      const digits = countDigits(text, next);
      if (separator === 'adjacent') {
        break;
      } else if (separator === 'range' && label.wordForm && digits <= 2) {
        seasonNumber = parseInt(text.slice(next, next + digits), 10);
        nextEnd = next + digits;
      } else if (separator === 'range' && !label.wordForm && digits > 2) {
        break;
      } else {
        return { kind: 'invalid' };
      }
    } else {
      const continuation = classifyEpisodeContinuation(text, next);
      if (separator !== 'adjacent' && continuation !== 'none') {
        return { kind: 'invalid' };
      }
      break;
    }
    if (separator === 'range') {
      const last = seasons.at(-1)!;
      if (seasonNumber <= last || seasonNumber - last > 99) return { kind: 'invalid' };
      for (let season = last + 1; season <= seasonNumber; season++) seasons.push(season);
    } else {
      if (seasonNumber <= seasons.at(-1)!) return { kind: 'invalid' };
      seasons.push(seasonNumber);
    }
    chained = true;
    end = nextEnd;
  }

  if (chained) {
    let after = end;
    while (isSeasonEpisodeSeparator(text[after])) after++;
    if (isEpisodeMarkerAt(text, after) || classifyEpisodeContinuation(text, after) === 'invalid') {
      return { kind: 'invalid' };
    }
  }

  const immediate = text[label.end];
  if (immediate === '_') {
    let next = cursor;
    const digits = countDigits(text, next);
    if (digits > 0 && (label.wordForm || digits <= 2)) return { kind: 'invalid' };
  }
  if (!chained && isWordCharAt(text, label.end) && immediate !== '_' && immediate?.toLowerCase() !== 'e') {
    return { kind: 'invalid' };
  }
  if (!chained && immediate?.toLowerCase() === 'e' && !isEpisodeMarkerAt(text, label.end)) return { kind: 'invalid' };
  return { kind: 'claim', seasons, episodes: null, end };
}

function readEpisodeClaim(text: string, start: number): EpisodeRead {
  const first = readEpisodeAtom(text, start);
  if (first.kind !== 'atom') return { kind: 'invalid' };
  let cursor = first.end;
  const episodes = [first.episode];
  let usedRange = false;

  while (cursor < text.length) {
    let next = cursor;
    while (isEpisodeChainSeparator(text[next])) next++;
    let range = false;
    if (isEpisodeRangeDash(text[next])) {
      range = true;
      next++;
      while (isEpisodeChainSeparator(text[next])) next++;
      const continuation = classifyEpisodeContinuation(text, next);
      if (continuation !== 'claim') {
        if (continuation === 'invalid') return { kind: 'invalid' };
        if (isAsciiDigit(text[next])) return { kind: 'invalid' };
        break; // A normal release-group suffix such as -GROUP is not an episode continuation.
      }
    } else if (!isEpisodeMarkerAt(text, next)) {
      if (isSeasonListSeparator(text[next]) && followedByNumber(text, next + 1)) return { kind: 'invalid' };
      if (isWordCharAt(text, cursor) && !isEpisodeMarkerAt(text, cursor)) return { kind: 'invalid' };
      break;
    }

    if (usedRange) return { kind: 'invalid' };
    if (range && episodes.length > 1) return { kind: 'invalid' };
    const subsequent = readEpisodeAtom(text, next);
    if (subsequent.kind !== 'atom') return { kind: 'invalid' };
    if (range) {
      if (subsequent.episode < first.episode || subsequent.episode - first.episode > 300) {
        return { kind: 'invalid' };
      }
      for (let episode = first.episode + 1; episode <= subsequent.episode; episode++) episodes.push(episode);
      usedRange = true;
    } else {
      episodes.push(subsequent.episode);
    }
    cursor = subsequent.end;
  }

  // A trailing word/digit glued to an atom is not a valid boundary; the revision was consumed above.
  if (isWordCharAt(text, cursor) && !isEpisodeMarkerAt(text, cursor)) return { kind: 'invalid' };
  return { kind: 'claim', claim: { episodes, end: cursor } };
}

type AtomRead = { kind: 'none' } | { kind: 'invalid' } | { kind: 'atom'; episode: number; end: number };

function readEpisodeAtom(text: string, start: number): AtomRead {
  const marker = readEpisodeMarker(text, start);
  if (!marker) return { kind: 'none' };
  let cursor = marker.numberStart;
  const numberStart = cursor;
  while (isAsciiDigit(text[cursor])) cursor++;
  if (cursor === numberStart || cursor - numberStart > 3) return { kind: 'invalid' };
  const episode = parseInt(text.slice(numberStart, cursor), 10);

  if (text[cursor]?.toLowerCase() === 'v') {
    cursor++;
    const revisionStart = cursor;
    while (isAsciiDigit(text[cursor])) cursor++;
    if (cursor === revisionStart || cursor - revisionStart > 2) return { kind: 'invalid' };
  }

  if (marker.wordForm && isWordCharAt(text, cursor) && !isEpisodeMarkerAt(text, cursor)) return { kind: 'invalid' };
  return { kind: 'atom', episode, end: cursor };
}

function isOnlyClaimSeparators(text: string): boolean {
  return /^[\s._,:;/\-–—−]*$/u.test(text);
}

function isEpisodeSignalAt(text: string, index: number): boolean {
  return isTokenBoundaryBefore(text, index) && readEpisodeMarker(text, index) !== null;
}

function isEpisodeMarkerAt(text: string, index: number): boolean {
  return readEpisodeMarker(text, index) !== null;
}

/** One continuation decision is shared by raw claims and cross-container validation. */
function classifyEpisodeContinuation(text: string, index: number): EpisodeContinuation {
  if (isEpisodeMarkerAt(text, index)) return 'claim';
  if (
    text.slice(index, index + 7).toLowerCase() === 'episode' &&
    !isUnicodeLetterAt(text, index + 7)
  ) return 'none';
  if (text[index]?.toLowerCase() === 'e') return 'invalid';
  return 'none';
}

/** Shared marker reader for both claim parsing and container-attempt detection. */
function readEpisodeMarker(text: string, index: number): EpisodeMarker | null {
  if (index >= text.length) return null;
  const wordForm = text.slice(index, index + 7).toLowerCase() === 'episode';
  if (wordForm) {
    let cursor = index + 7;
    if (isUnicodeLetterAt(text, cursor)) return null;
    let structuralSeparator = false;
    while (isEpisodeAtomSeparator(text[cursor])) {
      structuralSeparator ||= text[cursor] === '.' || text[cursor] === '_';
      cursor++;
    }
    if (cursor === text.length || isAsciiDigit(text[cursor]) || (structuralSeparator && isWordCharAt(text, cursor))) {
      return { wordForm: true, numberStart: cursor };
    }
    return null;
  }
  if (text[index]?.toLowerCase() !== 'e') return null;
  let cursor = index + 1;
  let structuralSeparator = false;
  while (isEpisodeAtomSeparator(text[cursor])) {
    structuralSeparator ||= text[cursor] === '.' || text[cursor] === '_';
    cursor++;
  }
  if (cursor === text.length || isAsciiDigit(text[cursor]) || (structuralSeparator && isWordCharAt(text, cursor))) {
    return { wordForm: false, numberStart: cursor };
  }
  return null;
}

function isTokenBoundaryBefore(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text.codePointAt(index - (isLowSurrogate(text.charCodeAt(index - 1)) ? 2 : 1));
  return previous === undefined || previous === 0x5f || !isWordChar(String.fromCodePoint(previous));
}

function isWordCharAt(text: string, index: number): boolean {
  if (index >= text.length) return false;
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined && isWordChar(String.fromCodePoint(codePoint));
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

function isUnicodeLetterAt(text: string, index: number): boolean {
  if (index >= text.length) return false;
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined && /\p{L}/u.test(String.fromCodePoint(codePoint));
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function countDigits(text: string, index: number): number {
  let cursor = index;
  while (isAsciiDigit(text[cursor])) cursor++;
  return cursor - index;
}

function isSeasonSeparator(char: string | undefined): boolean {
  return char !== undefined && /[\s._-]/u.test(char);
}

function isSeasonEpisodeSeparator(char: string | undefined): boolean {
  return char !== undefined && /[\s._]/u.test(char);
}

function isEpisodeAtomSeparator(char: string | undefined): boolean {
  return char !== undefined && /[\s._]/u.test(char);
}

function isEpisodeChainSeparator(char: string | undefined): boolean {
  return char !== undefined && /[\s._]/u.test(char);
}

function isSeasonRangeDash(char: string | undefined): boolean {
  return char !== undefined && /[-–—−]/u.test(char);
}

function isEpisodeRangeDash(char: string | undefined): boolean {
  return char !== undefined && /[-–—−]/u.test(char);
}

function isSeasonListSeparator(char: string | undefined): boolean {
  return char !== undefined && /[,;/]/u.test(char);
}

function followedByNumber(text: string, index: number): boolean {
  let cursor = index;
  while (isSeasonEpisodeSeparator(text[cursor])) cursor++;
  return isAsciiDigit(text[cursor]);
}

function maskRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) chars[i] = ' ';
}

// --- fallback sanitization --------------------------------------------------

const RESOLUTIONS = [360, 480, 576, 720, 1080, 1440, 2160, 4320];
const isYear = (n: number) => n >= 1920 && n <= 2099;

function sanitize(title: string): string {
  let t = title;
  t = t.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  t = t.replace(/\b(?:19|20)\d{2}[-. ]\d{1,2}[-. ]\d{1,2}\b/g, ' ');
  t = t.replace(/\b(?:2\.0|5\.1|7\.1)(?=$|[.\s_-])/g, ' ');
  t = t.replace(/\b\d{1,3}\.\d{1,3}(?![\d.])/g, ' ');
  t = t.replace(/\b\d{1,2}[- ]?bit\b/gi, ' ');
  t = t.replace(/\b(?:vol(?:ume)?|part|chapter|cour|book)\.?\s*\d+(?:-\d+)?\b/gi, ' ');
  t = t.replace(/(\d)v\d{1,2}\b/gi, '$1');
  t = t.replace(/[._]/g, ' ');
  return t;
}

const ABS_RE = /(?:^|[\s-])(\d{1,4})(?:-(\d{1,4}))?(?=[\s-]|$)/g;

function matchAbsolute(title: string): number[] | null {
  const out: number[] = [];
  for (const match of title.matchAll(ABS_RE)) {
    const start = parseInt(match[1]!, 10);
    const end = match[2] === undefined ? start : parseInt(match[2], 10);
    if (end < start || end - start > 300) continue;
    if (RESOLUTIONS.includes(start) || isYear(start)) continue;
    if (end !== start && (RESOLUTIONS.includes(end) || isYear(end))) continue;
    for (let episode = start; episode <= end; episode++) out.push(episode);
  }
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}

/** Invalid bare ranges are distinct from absent episode evidence and cannot unlock pack inference. */
function hasRejectedAbsoluteRange(title: string): boolean {
  for (const match of title.matchAll(ABS_RE)) {
    if (match[2] === undefined) continue;
    const start = parseInt(match[1]!, 10);
    const end = parseInt(match[2], 10);
    if (
      end < start || end - start > 300 || RESOLUTIONS.includes(start) ||
      RESOLUTIONS.includes(end) || isYear(start) || isYear(end)
    ) return true;
  }
  return false;
}
