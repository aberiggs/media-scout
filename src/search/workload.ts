import type { ArrTarget } from './arr';
import { EPISODE_SET_LIMITS, searchRequestSchema, type SearchRequest } from './contracts';
import { safeText } from './service';

export function buildEpisodeSetRequest(input: {
  show?: Record<string, unknown>; targets: ArrTarget[]; related: ArrTarget[]; observedAt: number;
  maxTargets?: number; maxContextBytes?: number;
}): { request: SearchRequest; targetRefs: Array<{ targetId: string; key: string }>; deferredTargets: number; omittedRelatedEpisodes: number; workload: { observedAt: number; selectedTargets: number; deferredTargets: number; omittedRelatedEpisodes: number } } {
  const cap = Math.min(EPISODE_SET_LIMITS.targets, Math.max(1, input.maxTargets ?? EPISODE_SET_LIMITS.targets));
  const ordered = [...input.targets].sort((a, b) => (a.airAt ?? 0) - (b.airAt ?? 0) || a.key.localeCompare(b.key));
  if (!ordered.length || ordered.some(t => t.provider !== 'sonarr') ||
      new Set(ordered.map(t => `${t.provider}:${t.sourceFingerprint}:${t.serviceId}`)).size !== 1)
    throw new Error('episode-set targets must belong to one observed show');
  const showIdentity = `${ordered[0]!.provider}:${ordered[0]!.sourceFingerprint}:${ordered[0]!.serviceId}`;
  if (input.related.some(t => `${t.provider}:${t.sourceFingerprint}:${t.serviceId}` !== showIdentity))
    throw new Error('related episodes must belong to the requested show');
  const selected = ordered.slice(0, cap);
  const refs = selected.map((target, i) => ({ targetId: `target-${i + 1}`, key: target.key }));
  const allowedEpisode = (t: ArrTarget, targetId?: string, ref?: string) => {
    const c = t.context;
    const air = t.airAt === undefined ? undefined : new Date(t.airAt).toISOString();
    return {
      ...(targetId ? { targetId } : { episodeRef: ref! }),
      ...(typeof c.seasonNumber === 'number' ? { seasonNumber: c.seasonNumber } : {}),
      ...(typeof c.episodeNumber === 'number' ? { episodeNumber: c.episodeNumber } : {}),
      ...(typeof c.absoluteEpisodeNumber === 'number' && c.absoluteEpisodeNumber > 0 ? { absoluteEpisodeNumber: c.absoluteEpisodeNumber } : {}),
      ...(typeof c.episodeTitle === 'string' && c.episodeTitle.trim() ? { title: safeText(c.episodeTitle) } : {}),
      ...(air ? { airDateUtc: air } : {}),
      ...(!targetId ? { hasFile: t.hasFile, queued: t.queued ?? false, monitored: t.monitored,
        available: t.available, contextReason: t.hasFile ? 'already-owned' : !t.monitored ? 'unmonitored' : t.queued ? (t.queueReason ?? 'queued') : !t.available ? 'not-yet-available' : 'not-actionable' } : {}),
    };
  };
  const show = input.show ?? selectedShowContext(ordered[0]!);
  const { overview, titles, externalIds, originalLanguage, seriesType, profileContext } = show;
  if (typeof overview === 'string' && safeText(overview).length > 4000)
    throw new Error('episode-set context budget exceeded: show overview exceeds its schema bound');
  const safeTitles = Array.isArray(titles) ? titles.filter((v): v is string => typeof v === 'string').map(value => safeText(value)) : undefined;
  const safeIds = typeof externalIds === 'object' && externalIds !== null ? Object.fromEntries(Object.entries(externalIds).filter(([, v]) => typeof v === 'string' || typeof v === 'number')) : undefined;
  const targetDetails = selected.map((t, i) => allowedEpisode({ ...t, context: t.episodeContext ?? t.context }, refs[i]!.targetId));
  const fullRelated = input.related.filter(t => !selected.some(s => s.key === t.key)).map((t, i) => allowedEpisode({ ...t, context: t.episodeContext ?? t.context }, undefined, `related-${i + 1}`));
  const base: Record<string, unknown> = { kind: 'tv', ...(safeTitles ? { titles: safeTitles } : {}), ...(safeIds ? { externalIds: safeIds } : {}),
    ...(typeof originalLanguage === 'string' ? { originalLanguage: safeText(originalLanguage) } : {}), ...(seriesType ? { seriesType } : {}),
    ...(profileContext === undefined ? {} : { profileContext }), ...(typeof overview === 'string' ? { overview: safeText(overview) } : {}),
    scope: { type: 'episode-set' }, targets: targetDetails, relatedEpisodes: [] };
  const maxBytes = input.maxContextBytes ?? EPISODE_SET_LIMITS.requestBytes;
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const requestFor = (relatedEpisodes: unknown[], omitted: number) => ({
    prompt: 'Find suitable releases for these requested episodes.', context: {
      ...base, relatedEpisodes, ...(omitted ? { relatedEpisodesOmitted: omitted } : {}),
    },
  });
  if (bytes(requestFor([], fullRelated.length)) > maxBytes) throw new Error('episode-set context budget exceeded: requested target context cannot fit');
  // Search a bounded prefix before schema validation; long inventories need not be
  // repeatedly parsed or serialized one removed episode at a time.
  let low = 0, high = Math.min(fullRelated.length, EPISODE_SET_LIMITS.relatedEpisodes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(requestFor(fullRelated.slice(0, middle), fullRelated.length - middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const included = fullRelated.slice(0, low);
  const omittedRelatedEpisodes = fullRelated.length - included.length;
  const request = searchRequestSchema.parse(requestFor(included, omittedRelatedEpisodes));
  const deferredTargets = ordered.length - selected.length;
  return { request, targetRefs: refs, deferredTargets, omittedRelatedEpisodes,
    workload: { observedAt: input.observedAt, selectedTargets: selected.length, deferredTargets, omittedRelatedEpisodes } };
}

function selectedShowContext(target: ArrTarget): Record<string, unknown> {
  return target.showContext ?? {};
}
