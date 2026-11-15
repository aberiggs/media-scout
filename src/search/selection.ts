import { rankedOptionSchema, type RankedOption } from './contracts';

export function validateRankedOptions(
  input: unknown[], candidates: Set<string>, targets: Set<string>, scope: { type: string; seasonNumber?: number; episodeNumber?: number; absoluteEpisodeNumber?: number; candidateSeasons?: Record<string, number[]>; candidateScopes?: Record<string, import('../core/parser').ParsedReleaseCoverage[]> },
): { valid: boolean; options: RankedOption[]; error?: string } {
  const parsed = input.map(value => rankedOptionSchema.safeParse(value));
  if (parsed.some(x => !x.success)) return { valid: false, options: [], error: 'invalid option schema' };
  const options = parsed.map(x => (x as { success: true; data: RankedOption }).data);
  if (!options.length || options.length > 5) return { valid: false, options: [], error: 'invalid option count' };
  if (new Set(options.map(o => o.optionId)).size !== options.length || options.some((o, index) => o.rank !== index + 1)) return { valid: false, options: [], error: 'invalid option ranks' };
  for (const option of options) {
    if (option.releases.some(r => !candidates.has(r.candidateId))) return { valid: false, options: [], error: 'unobserved candidate reference' };
    if (new Set(option.releases.map(r => r.candidateId)).size !== option.releases.length) return { valid: false, options: [], error: 'duplicate physical release' };
    if (option.coveredTargetIds.some(id => !targets.has(id)) || new Set(option.coveredTargetIds).size !== option.coveredTargetIds.length) return { valid: false, options: [], error: 'invalid target reference' };
    if (scope.type !== 'season' && option.releases.length !== 1) return { valid: false, options: [], error: 'non-season option must use one release' };
    if (scope.type === 'season' && option.releases.length > 3) return { valid: false, options: [], error: 'season option exceeds three releases' };
    if (scope.seasonNumber !== undefined && option.releases.some(r => scope.candidateSeasons?.[r.candidateId]?.some(n => n !== scope.seasonNumber))) return { valid: false, options: [], error: 'explicit wrong season' };
    const footprints = new Set<number>();
    for (const release of option.releases) {
      const observations = scope.candidateScopes?.[release.candidateId] ?? [];
      for (const evidence of observations) {
        if (evidence.kind === 'invalid' && !observations.some(e => e.kind === 'claims')) return { valid: false, options: [], error: 'conflicting scope' };
        if (evidence.kind !== 'claims') continue;
        if (scope.seasonNumber !== undefined && evidence.seasonClaims.some(c => c.seasonNumber !== scope.seasonNumber)) return { valid: false, options: [], error: 'explicit wrong season' };
        if (scope.type === 'episode' && scope.episodeNumber !== undefined && evidence.seasonClaims.some(c => c.episodes !== null && !c.episodes.includes(scope.episodeNumber!))) return { valid: false, options: [], error: 'explicit wrong episode' };
        if (scope.type === 'episode' && scope.episodeNumber !== undefined && evidence.unqualifiedEpisodes !== null && !evidence.unqualifiedEpisodes.includes(scope.episodeNumber)) return { valid: false, options: [], error: 'explicit wrong episode' };
        // Bare-number parsing is fallback evidence, not an override of an explicit SxxEyy claim.
        if (scope.type === 'episode' && scope.absoluteEpisodeNumber !== undefined && evidence.seasonClaims.length === 0 && evidence.unqualifiedEpisodes === null && evidence.absoluteEpisodes !== null && !evidence.absoluteEpisodes.includes(scope.absoluteEpisodeNumber)) return { valid: false, options: [], error: 'explicit wrong absolute episode' };
      }
      if (option.releases.length > 1) {
        const evidence = scope.candidateScopes?.[release.candidateId] ?? [];
        const claims = evidence.flatMap(e => e.kind === 'claims' ? e.seasonClaims : []);
        if (!claims.length || claims.some(c => c.episodes === null)) return { valid: false, options: [], error: 'unproven non-overlap' };
        const episodes = new Set(claims.flatMap(c => c.episodes ?? []));
        if ([...episodes].some(e => footprints.has(e))) return { valid: false, options: [], error: 'overlapping episode plans' };
        for (const episode of episodes) footprints.add(episode);
      }
    }
    if (targets.size > 0 && option.coveredTargetIds.length === 0) return { valid: false, options: [], error: 'missing target coverage' };
  }
  return { valid: true, options };
}
