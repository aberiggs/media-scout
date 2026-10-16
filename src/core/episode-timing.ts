import type { Episode } from '../types/sonarr';

/** Conservative eligibility instant: exact UTC airtime, otherwise the day after a valid calendar date. */
export function episodeEligibilityTime(episode: Pick<Episode, 'airDate' | 'airDateUtc'>): Date | null {
  const precise = episode.airDateUtc;
  if (precise && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(precise)) {
    const timestamp = Date.parse(precise);
    if (Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === precise.slice(0, 19)) return new Date(timestamp);
  }

  const date = episode.airDate;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed;
}
