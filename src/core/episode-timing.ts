import type { Episode } from '../types/sonarr';

/** Preserve the provider's date precision alongside the conservative eligibility instant. */
export function episodeAiring(episode: Pick<Episode, 'airDate' | 'airDateUtc'>): { metadataAirDate: string; airAt: number } | null {
  const precise = episode.airDateUtc;
  if (precise && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(precise)) {
    const timestamp = Date.parse(precise);
    if (Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === precise.slice(0, 19))
      return { metadataAirDate: new Date(timestamp).toISOString(), airAt: timestamp };
  }

  const date = episode.airDate;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return { metadataAirDate: date, airAt: parsed.getTime() };
}

export function offsetEligibilityTime(airAt: number | undefined, earlyHours: number): number | undefined {
  return airAt === undefined ? undefined : airAt - earlyHours * 3_600_000;
}
