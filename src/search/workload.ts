import type { ArrTarget } from './arr';
import { EPISODE_SET_LIMITS } from './contracts';
import { episodeRows, type PromptEpisode } from './prompt';
import { safeText } from './release-observation';

const PACK_PREFERENCE = 'Prefer complete coverage over too few downloads, even if a pack includes extra episodes. Prefer healthy, high-grab, high-quality season packs to individual episodes when suitable, even for a single episode or subset. Overlapping packs are welcome when they improve coverage or quality (e.g. S1+S2 and S2+S3 for S1–S3); do not sacrifice quality or confidence just to avoid overlap.';

export function buildAutomationPrompt(input: {
  targets: ArrTarget[]; preferences: string; secrets: readonly string[];
  maxBytes?: number; prioritize?: (a: ArrTarget, b: ArrTarget) => number;
}): { prompt: string; kind: 'movie' | 'tv'; selectedTargets: ArrTarget[]; deferredTargets: number } {
  const first = input.targets[0];
  if (!first || input.targets.some(target => target.provider !== first.provider ||
    target.sourceFingerprint !== first.sourceFingerprint || target.serviceId !== first.serviceId ||
    target.externalId !== first.externalId) || (first.provider === 'radarr' && input.targets.length !== 1)) {
    throw new Error('Automation targets must belong to one observed show or movie');
  }
  const media = first.showContext ?? first.context;
  const titles = [...new Set([media.title, ...(Array.isArray(media.titles) ? media.titles : [])]
    .flatMap(value => typeof value === 'string' && value.trim() ? [safeText(value, input.secrets).trim()] : []).filter(Boolean))];
  if (!titles.length) throw new Error('Automation media title unavailable');
  const aliasSeasons = new Map<string, Set<number>>();
  for (const alias of Array.isArray(media.titleAliases) ? media.titleAliases : []) {
    if (!alias || typeof alias.title !== 'string' || !Number.isSafeInteger(alias.seasonNumber) || alias.seasonNumber < 0) continue;
    const title = safeText(alias.title, input.secrets).trim();
    const seasons = aliasSeasons.get(title) ?? new Set<number>();
    seasons.add(alias.seasonNumber);
    aliasSeasons.set(title, seasons);
  }
  const titleHints = titles.map(title => aliasSeasons.has(title) ? { title, providerSeasons: [...aliasSeasons.get(title)!] } : title);
  const budget = input.maxBytes ?? EPISODE_SET_LIMITS.requestBytes;
  const preferences = safeText(input.preferences, input.secrets, true).trim();
  const preferenceSection = preferences ? `\n\nTry to find releases that match these preferences as closely as possible:\n${preferences}` : '';
  const movie = first.provider === 'radarr';
  const year = typeof media.year === 'number' && media.year >= 1888 && media.year <= 2200 ? ` (${media.year})` : '';
  const intro = `Find releases for ${movie ? 'the movie ' : 'the series '}${JSON.stringify(titles[0])}${year}.`;
  const titleSection = `Our metadata provider lists these titles: ${JSON.stringify(titleHints)}. You may find other titles while researching; aliases and provider season labels are search hints, not additional requests.`;
  if (movie) {
    const prompt = `${intro}\n\n${titleSection}${preferenceSection}`;
    if (Buffer.byteLength(prompt) > budget) throw new Error('Automation movie prompt cannot fit');
    return { prompt, kind: 'movie', selectedTargets: [first], deferredTargets: 0 };
  }
  const prefix = `${intro}\n\n${titleSection}\n\n`;
  const suffix = `\n\n${PACK_PREFERENCE}${preferenceSection}`;
  const rows: { season: number; episode: number; encoded: string }[] = [], selectedTargets: ArrTarget[] = [];
  let bytes = Buffer.byteLength(prefix + episodeRows([]) + suffix);
  const ordered = [...input.targets].sort((a, b) =>
    (input.prioritize?.(a, b) ?? 0) || (a.airAt ?? 0) - (b.airAt ?? 0) || a.key.localeCompare(b.key));
  for (const target of ordered.slice(0, EPISODE_SET_LIMITS.targets)) {
    const context = target.episodeContext ?? target.context;
    const { seasonNumber, episodeNumber, absoluteEpisodeNumber, episodeTitle } = context;
    if (typeof seasonNumber !== 'number' || !Number.isSafeInteger(seasonNumber) || seasonNumber < 0 ||
      typeof episodeNumber !== 'number' || !Number.isSafeInteger(episodeNumber) || episodeNumber < 0)
      throw new Error('Automation episode numbering unavailable');
    const row: PromptEpisode = {
      season: seasonNumber, episode: episodeNumber,
      ...(typeof absoluteEpisodeNumber === 'number' && absoluteEpisodeNumber > 0 ? { absoluteEpisode: absoluteEpisodeNumber } : {}),
      ...(typeof episodeTitle === 'string' && episodeTitle.trim() ? { title: safeText(episodeTitle, input.secrets) } : {}),
      ...(media.seriesType === 'daily' && target.airAt !== undefined
        ? { airDate: typeof context.airDate === 'string' ? context.airDate : new Date(target.airAt).toISOString().slice(0, 10) } : {}),
    };
    const encoded = JSON.stringify(row);
    const extraBytes = Buffer.byteLength(encoded) + (rows.length ? 2 : 0);
    if (bytes + extraBytes > budget) break;
    bytes += extraBytes;
    rows.push({ season: seasonNumber, episode: episodeNumber, encoded });
    selectedTargets.push(target);
  }
  if (!selectedTargets.length) throw new Error('Automation episode prompt cannot fit');
  const orderedRows = rows.sort((a, b) => a.season - b.season || a.episode - b.episode).map(row => row.encoded);
  return { prompt: prefix + episodeRows(orderedRows) + suffix, kind: 'tv', selectedTargets, deferredTargets: ordered.length - selectedTargets.length };
}
