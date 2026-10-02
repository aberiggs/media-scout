import type { ParsedTitle } from './parser';
import type { GroupCoverageResult, ParsedReleaseCoverage, TargetCoverage } from './group-types';
import type { Release } from '../types/prowlarr';
import type { WorkUnit } from './watcher';

export interface EpisodeCoverage {
  episodeId: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number | null;
  title: string;
}

export type CoverageBasis = 'explicit-episodes' | 'inferred-season-pack';

export type VerifyResult =
  | { ok: true; kind: 'tv'; coverageBasis: CoverageBasis; covered: EpisodeCoverage[] }
  | { ok: true; kind: 'movie' }
  | {
      ok: false;
      reason: 'unparseable' | 'no-episode-map' | 'season-mismatch';
    };

/**
 * I1 (D2, user directive 2026-09-30): deterministic code enforces ONLY the TV
 * episode map. Movie identity and candidate quality are the picker LLM's
 * judgment — guardrails supply evidence to the prompt, never a matching verdict.
 */
export function verifyRelease(args: {
  unit: WorkUnit;
  release: Release;
  parsed: ParsedTitle;
}): VerifyResult {
  const { unit, parsed } = args;
  if (unit.kind === 'movie') return { ok: true, kind: 'movie' };
  return verifyTv(unit, parsed);
}

/** Resolve one physical release against the original group inventory and its caller-authorized targets. */
export function verifyGroupCoverage(args: {
  originalUnits: WorkUnit[];
  actionableUnits: WorkUnit[];
  parsed: ParsedReleaseCoverage;
}): GroupCoverageResult {
  const { originalUnits, actionableUnits, parsed } = args;
  if (!isStructurallyRelatedGroup(originalUnits) || !isActionableSubset(originalUnits, actionableUnits)) {
    return { kind: 'invalid', reason: 'invalid' };
  }

  if (originalUnits[0]!.kind === 'movie') {
    const original = originalUnits[0]!;
    if (actionableUnits.length === 0) return { kind: 'no-map', reason: 'no-map' };
    return {
      kind: 'covered',
      requestedFootprint: [{ workKey: original.key, episodeIds: null, basis: null }],
      capture: [{ workKey: original.key, episodeIds: null, basis: null }],
      extraSeasons: [],
    };
  }

  if (parsed.kind === 'invalid') return { kind: 'invalid', reason: 'invalid' };
  if (parsed.kind === 'none') return { kind: 'no-map', reason: 'no-map' };

  const tvUnits = originalUnits;
  const requestedSeasons = new Set(tvUnits.map((unit) => unit.season!.seasonNumber));
  const seasonClaims = parsed.wholeSeries && parsed.seasonClaims.length === 0 &&
    parsed.absoluteEpisodes === null && parsed.unqualifiedEpisodes === null
    ? [...requestedSeasons].map((seasonNumber) => ({ seasonNumber, episodes: null }))
    : parsed.seasonClaims;
  const extraSeasons = [...new Set(parsed.seasonClaims
    .map((claim) => claim.seasonNumber)
    .filter((seasonNumber) => !requestedSeasons.has(seasonNumber)))].sort((a, b) => a - b);
  const mapped = new Map<string, { ids: Set<number>; basis: TargetCoverage['basis'] }>();

  const addCoverage = (unit: WorkUnit, episodeIds: number[], basis: TargetCoverage['basis']): void => {
    if (episodeIds.length === 0) return;
    const existing = mapped.get(unit.key);
    if (!existing) {
      mapped.set(unit.key, { ids: new Set(episodeIds), basis });
      return;
    }
    for (const episodeId of episodeIds) existing.ids.add(episodeId);
    if (basis === 'explicit-episodes') existing.basis = basis;
  };

  for (const claim of seasonClaims) {
    const unit = tvUnits.find((candidate) => candidate.season!.seasonNumber === claim.seasonNumber);
    if (!unit) continue;
    const missing = unit.season!.missing;
    if (claim.episodes === null) {
      addCoverage(unit, missing.map((episode) => episode.episodeId), 'inferred-season-pack');
      continue;
    }
    const numbers = new Set(claim.episodes);
    addCoverage(
      unit,
      missing.filter((episode) => numbers.has(episode.episodeNumber)).map((episode) => episode.episodeId),
      'explicit-episodes',
    );
  }

  if (parsed.absoluteEpisodes !== null) {
    const eligibleUnits = parsed.seasonClaims.length === 0
      ? tvUnits.filter((unit) => unit.seriesType === 'anime')
      : tvUnits.filter((unit) => unit.seriesType === 'anime' &&
        parsed.seasonClaims.some((claim) => claim.seasonNumber === unit.season!.seasonNumber));
    const absoluteNumbers = new Set(parsed.absoluteEpisodes);
    for (const unit of eligibleUnits) {
      addCoverage(
        unit,
        unit.season!.missing
          .filter((episode) => episode.absoluteEpisodeNumber !== null && absoluteNumbers.has(episode.absoluteEpisodeNumber))
          .map((episode) => episode.episodeId),
        'explicit-episodes',
      );
    }
  }

  // An E-only claim is an exact episode subset only when the supplied group has one unambiguous season.
  if (parsed.unqualifiedEpisodes !== null && parsed.seasonClaims.length === 0 && tvUnits.length === 1) {
    const unit = tvUnits[0]!;
    const numbers = new Set(parsed.unqualifiedEpisodes);
    addCoverage(
      unit,
      unit.season!.missing.filter((episode) => numbers.has(episode.episodeNumber)).map((episode) => episode.episodeId),
      'explicit-episodes',
    );
  }

  const requestedFootprint: TargetCoverage[] = tvUnits.flatMap((unit) => {
    const entry = mapped.get(unit.key);
    if (!entry || entry.ids.size === 0) return [];
    const ids = unit.season!.missing
      .filter((episode) => entry.ids.has(episode.episodeId))
      .map((episode) => episode.episodeId);
    return ids.length ? [{ workKey: unit.key, episodeIds: ids, basis: entry.basis }] : [];
  });
  const actionableByKey = new Map(actionableUnits.map((unit) => [unit.key, unit]));
  const capture: TargetCoverage[] = requestedFootprint.flatMap((footprint) => {
    const original = tvUnits.find((unit) => unit.key === footprint.workKey)!;
    const actionable = actionableByKey.get(footprint.workKey);
    if (!actionable || footprint.episodeIds === null) return [];
    const actionableIds = new Set(actionable.season!.missing.map((episode) => episode.episodeId));
    const episodeIds = footprint.episodeIds.filter((episodeId) => actionableIds.has(episodeId));
    return episodeIds.length ? [{ workKey: original.key, episodeIds, basis: footprint.basis }] : [];
  });

  if (requestedFootprint.length === 0 || capture.length === 0) return { kind: 'no-map', reason: 'no-map' };
  return { kind: 'covered', requestedFootprint, capture, extraSeasons };
}

function isStructurallyRelatedGroup(units: WorkUnit[]): boolean {
  if (units.length === 0) return false;
  const first = units[0]!;
  if (units.some((unit) => unit.kind !== first.kind || unit.arr !== first.arr ||
    unit.serviceId !== first.serviceId || unit.externalId !== first.externalId)) return false;
  if (new Set(units.map((unit) => unit.key)).size !== units.length) return false;
  if (first.kind === 'movie') return units.length === 1;
  if (units.some((unit) => unit.season === undefined || unit.seriesType !== first.seriesType)) return false;
  return new Set(units.map((unit) => unit.season!.seasonNumber)).size === units.length;
}

function isActionableSubset(originalUnits: WorkUnit[], actionableUnits: WorkUnit[]): boolean {
  const originalByKey = new Map(originalUnits.map((unit) => [unit.key, unit]));
  if (new Set(actionableUnits.map((unit) => unit.key)).size !== actionableUnits.length) return false;
  return actionableUnits.every((actionable) => {
    const original = originalByKey.get(actionable.key);
    if (!original || original.kind !== actionable.kind || original.arr !== actionable.arr ||
      original.serviceId !== actionable.serviceId || original.externalId !== actionable.externalId) return false;
    if (original.kind === 'movie') return actionable.kind === 'movie';
    if (actionable.kind !== 'tv' || original.season?.seasonNumber !== actionable.season?.seasonNumber ||
      original.seriesType !== actionable.seriesType) return false;
    const originalIds = new Set(original.season!.missing.map((episode) => episode.episodeId));
    return actionable.season!.missing.every((episode) => originalIds.has(episode.episodeId));
  });
}

function verifyTv(unit: WorkUnit, parsed: ParsedTitle): VerifyResult {
  const missing = unit.season?.missing ?? [];
  const seasonNumber = unit.season?.seasonNumber;

  if (
    parsed.season === null && parsed.seasonEpisodes === null &&
    parsed.absoluteEpisodes === null && parsed.seasonPack !== true
  ) {
    return { ok: false, reason: 'unparseable' };
  }

  // A known season is safety evidence even for anime releases carrying absolute numbers.
  if (parsed.season !== null && parsed.season !== seasonNumber) {
    return { ok: false, reason: 'season-mismatch' };
  }

  // Only a clean season-only parse can infer missing-episode coverage. Explicit evidence
  // always stays precise, even if it does not intersect this work unit.
  if (
    parsed.seasonPack === true && parsed.seasonEpisodes === null &&
    parsed.absoluteEpisodes === null
  ) {
    if (parsed.season !== seasonNumber) return { ok: false, reason: 'season-mismatch' };
    if (missing.length === 0) return { ok: false, reason: 'no-episode-map' };
    return {
      ok: true,
      kind: 'tv',
      coverageBasis: 'inferred-season-pack',
      covered: [...new Map(missing.map((episode) => [episode.episodeId, episode])).values()]
        .sort((a, b) => a.episodeNumber - b.episodeNumber),
    };
  }

  // Dynamic dedupe by episodeId; entries only ever come from `missing`.
  const covered = new Map<number, EpisodeCoverage>();
  let anyCovered = false;

  if (unit.seriesType === 'anime') {
    // Absolute mode: intersect parsed absolute numbers with missing episodes
    // that carry a non-null absoluteEpisodeNumber.
    const absTargets = new Set(
      missing.filter((m) => m.absoluteEpisodeNumber !== null).map((m) => m.absoluteEpisodeNumber),
    );
    for (const abs of parsed.absoluteEpisodes ?? []) {
      if (!absTargets.has(abs)) continue;
      const m = missing.find((x) => x.absoluteEpisodeNumber === abs)!;
      covered.set(m.episodeId, m);
      anyCovered = true;
    }
    // Mixed-numbering fallback: some anime releases use SxxEyy even for
    // absolute-numbered shows; intersect seasonEpisodes by episodeNumber too
    // (iterate missing so duplicate-episodeNumber anomalies all get covered).
    if (parsed.seasonEpisodes !== null && parsed.season === seasonNumber) {
      const seasonEps = new Set(parsed.seasonEpisodes);
      for (const m of missing) {
        if (seasonEps.has(m.episodeNumber)) {
          covered.set(m.episodeId, m);
          anyCovered = true;
        }
      }
    }
  } else {
    // standard | daily: (season, episode) matching only.
    if (parsed.season !== seasonNumber) return { ok: false, reason: 'season-mismatch' };
    const seasonEps = new Set(parsed.seasonEpisodes ?? []);
    for (const m of missing) {
      if (seasonEps.has(m.episodeNumber)) {
        covered.set(m.episodeId, m);
        anyCovered = true;
      }
    }
  }

  if (!anyCovered) return { ok: false, reason: 'no-episode-map' };
  return {
    ok: true,
    kind: 'tv',
    coverageBasis: 'explicit-episodes',
    // Deduplicated subset of unit.season.missing, ordered by episodeNumber.
    covered: [...covered.values()].sort((a, b) => a.episodeNumber - b.episodeNumber),
  };
}

/** Q2 rule: grabbable iff magnetUrl OR proxied downloadUrl is present. */
export function isGrabbable(release: Release): boolean {
  return release.magnetUrl !== null || release.downloadUrl !== null;
}
