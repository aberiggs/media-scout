import type { EpisodeProgress, WorkItem } from './work-queue-types';
import { episodeEligibilityTime } from './episode-timing';

export type ObservationState = 'known' | 'unknown' | 'stale';
export interface EpisodeSummary {
  knowledge: ObservationState;
  lifecycle: 'scheduled' | 'airing' | 'finished' | 'unknown';
  completion: 'caught-up' | 'imported' | 'incomplete' | 'unknown';
  counts: { total: number; imported: number; airedMissing: number; future: number; timingUnknown: number;
    unmonitored: number; downloading: number; held: number; ready: number; waitingRelease: number } | null;
  nextEligibilityAt: string | null;
  nextRetryAt: string | null;
}
export interface EpisodeRow {
  episodeNumber: number; absoluteEpisodeNumber: number | null; title: string; monitored: boolean; hasFile: boolean;
  eligibleAt: string | null; timingBasis: 'utc' | 'date-only' | 'unknown'; lastSearchAt: string | null; nextSearchAt: string | null;
  progress: 'imported' | 'unmonitored' | 'held' | 'timing-unknown' | 'waiting-air-date' | 'downloading' |
    'waiting-release' | 'cooldown' | 'retry-backoff' | 'ready' | 'searching' | 'unknown' | 'stale';
  holdReason: string | null; observedAt: string; observationState: ObservationState;
}
const UNSAFE_HOLDS = new Set(['queue-unknown', 'queue-ambiguous', 'queue-review', 'content-identity-changed', 'manual-review', 'library-unknown']);

/** Facts, scheduling and coverage share one projection for the season card, detail page and MCP summary. */
export function projectEpisodes(input: {
  work: WorkItem; episodes: EpisodeProgress[]; now: number; knowledge: ObservationState;
  observed: Set<string>; reserved: Set<string>; uncertain: Set<string>; blockingReview: boolean;
  safeTitle: (value: string) => string;
}): { items: EpisodeRow[]; summary: EpisodeSummary } {
  const { work, now } = input;
  const rows = input.episodes.filter((episode) => episode.workKey === work.workKey &&
    episode.serviceId === work.unit.serviceId && episode.externalId === work.unit.externalId &&
    episode.seasonNumber === work.unit.season?.seasonNumber)
    .sort((a, b) => a.episodeNumber - b.episodeNumber || a.episodeId - b.episodeId);
  const clocked = rows.some((episode) => episode.lastSearchAt !== null || episode.nextSearchAt !== null);
  const unknownHold = work.blockedReason !== null && !UNSAFE_HOLDS.has(work.blockedReason) &&
    !['queue-active', 'active-intent', 'waiting-release'].includes(work.blockedReason);
  const broadHold = UNSAFE_HOLDS.has(work.blockedReason ?? '') ? work.blockedReason
    : unknownHold ? 'blocked' : input.blockingReview || work.status === 'manual' ? 'manual-review' : null;
  const activeBackoff = work.status === 'backoff' && work.nextSearchAt !== null && Date.parse(work.nextSearchAt) > now;
  const items = rows.map((episode): EpisodeRow => {
    const observationState = episode.lastObservedAt !== work.lastObservedAt ? 'unknown' : input.knowledge;
    const eligibleAt = episodeEligibilityTime(episode);
    const precise = episodeEligibilityTime({ airDate: null, airDateUtc: episode.airDateUtc });
    const id = String(episode.episodeId);
    let progress: EpisodeRow['progress'];
    let holdReason: string | null = null;
    let nextSearchAt = episode.nextSearchAt;
    if (activeBackoff && (!nextSearchAt || Date.parse(work.nextSearchAt!) > Date.parse(nextSearchAt))) nextSearchAt = work.nextSearchAt;
    if (observationState !== 'known') progress = observationState;
    else if (episode.hasFile) { progress = 'imported'; nextSearchAt = null; }
    else if (!episode.monitored || work.status === 'inactive') { progress = 'unmonitored'; nextSearchAt = null; }
    else if (broadHold || input.uncertain.has(id)) { progress = 'held'; holdReason = broadHold ?? 'uncertain-download'; }
    else if (!eligibleAt) { progress = 'timing-unknown'; holdReason = 'timing-unknown'; }
    else if (eligibleAt.getTime() > now) { progress = 'waiting-air-date'; holdReason = 'waiting-air-date'; }
    else if (input.observed.has(id) || input.reserved.has(id)) { progress = 'downloading'; holdReason = input.observed.has(id) ? 'queue-active' : 'active-intent'; }
    else if (activeBackoff) { progress = 'retry-backoff'; holdReason = work.lastOutcome === 'rate-limited' ? 'rate-limited' : 'operation-backoff'; }
    else if (episode.nextSearchAt && Date.parse(episode.nextSearchAt) > now) progress = ['release-unavailable', 'legacy-availability'].includes(episode.lastOutcome ?? '') ? 'waiting-release' : 'cooldown';
    else if (!clocked && work.status === 'cooldown' && work.nextSearchAt && Date.parse(work.nextSearchAt) > now) { progress = 'cooldown'; nextSearchAt = work.nextSearchAt; }
    else if (work.status === 'searching') { progress = 'searching'; holdReason = 'search-in-progress'; }
    else if (work.status === 'fulfilled') { progress = 'held'; holdReason = 'unconfirmed-completion'; }
    else progress = 'ready';
    return { episodeNumber: episode.episodeNumber, absoluteEpisodeNumber: episode.absoluteEpisodeNumber,
      title: input.safeTitle(episode.title), monitored: episode.monitored, hasFile: episode.hasFile,
      eligibleAt: eligibleAt?.toISOString() ?? null, timingBasis: precise ? 'utc' : eligibleAt ? 'date-only' : 'unknown',
      lastSearchAt: episode.lastSearchAt, nextSearchAt, progress, holdReason, observedAt: episode.lastObservedAt, observationState };
  });
  const observedIds = new Set(rows.map((episode) => episode.episodeId));
  const missingEvidence = work.unit.season?.missing.some((episode) => !observedIds.has(episode.episodeId)) ?? false;
  const knowledge: ObservationState = !rows.length || missingEvidence || rows.some((episode) => episode.lastObservedAt !== work.lastObservedAt) ? 'unknown' : input.knowledge;
  const unknown: EpisodeSummary = { knowledge, lifecycle: 'unknown', completion: 'unknown', counts: null, nextEligibilityAt: null, nextRetryAt: null };
  if (knowledge !== 'known') return { items, summary: unknown };
  const counts = { total: rows.length, imported: 0, airedMissing: 0, future: 0, timingUnknown: 0, unmonitored: 0, downloading: 0, held: 0, ready: 0, waitingRelease: 0 };
  for (const [index, episode] of rows.entries()) {
    const item = items[index]!;
    const eligible = episodeEligibilityTime(episode);
    if (episode.hasFile) counts.imported++;
    else if (!episode.monitored || work.status === 'inactive') counts.unmonitored++;
    else if (!eligible) counts.timingUnknown++;
    else if (eligible.getTime() > now) counts.future++;
    else counts.airedMissing++;
    if (item.progress === 'downloading') counts.downloading++;
    if (item.progress === 'held') counts.held++;
    if (item.progress === 'ready') counts.ready++;
    if (item.progress === 'waiting-release') counts.waitingRelease++;
  }
  const nextEligibilityAt = items.filter((episode) => episode.monitored && !episode.hasFile && episode.eligibleAt && Date.parse(episode.eligibleAt) > now)
    .map((episode) => episode.eligibleAt!).sort()[0] ?? null;
  const nextRetryAt = items.filter((episode) => ['waiting-release', 'cooldown', 'retry-backoff'].includes(episode.progress) && episode.nextSearchAt && Date.parse(episode.nextSearchAt) > now)
    .map((episode) => episode.nextSearchAt!).sort()[0] ?? null;
  const anyFuture = rows.some((episode) => { const at = episodeEligibilityTime(episode); return at !== null && at.getTime() > now; });
  const anyAired = rows.some((episode) => { const at = episodeEligibilityTime(episode); return episode.hasFile || (at !== null && at.getTime() <= now); });
  const allAired = rows.every((episode) => { const at = episodeEligibilityTime(episode); return at !== null && at.getTime() <= now; });
  const finale = rows.some((episode) => ['season', 'series'].includes(episode.finaleType ?? ''));
  return { items, summary: { knowledge, counts, nextEligibilityAt, nextRetryAt,
    lifecycle: anyFuture ? anyAired ? 'airing' : 'scheduled' : finale && allAired ? 'finished' : 'unknown',
    completion: counts.imported === counts.total ? 'imported' : !counts.airedMissing && !counts.timingUnknown && !counts.held && counts.future > 0 ? 'caught-up' : 'incomplete' } };
}
