import { createHash } from 'node:crypto';
import type { Release } from '../types/prowlarr';
import { parseReleaseCoverage } from '../core/parser';

export interface CandidateObservation {
  title: string; indexer: string; size: number | null; seeders: number | null;
  leechers: number | null; grabs: number | null; age: number; protocol: string;
  tvdbId: number | null; tmdbId: number | null; indexerFlags: string[]; categories?: Array<{ id: number; name: string }>;
  scope: ReturnType<typeof parseReleaseCoverage>;
}

/** Sanitize display/model text; private locators remain only in candidate storage. */
export function safeText(value: string, secrets: string[] = []): string {
  const scrubbed = secrets.filter(secret => secret.length > 0).reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  return scrubbed.replace(/(?:https?:\/\/|magnet:\?)[^\s"<>]+/giu, '[private link]')
    .replace(/\b[\da-f]{32,64}\b/giu, '[private identifier]').replace(/[\u0000-\u001f\u007f]/gu, ' ');
}
export function physicalRelease(release: Pick<Release, 'infoHash' | 'indexerId' | 'guid'>): string {
  return createHash('sha256').update(release.infoHash?.toLowerCase() || `${release.indexerId}:${release.guid}`).digest('hex');
}
export function safeReleaseObservation(r: Release, secrets: string[] = [], includeCategories = false): CandidateObservation {
  const privateValues = [...secrets, r.guid, r.downloadUrl ?? '', r.magnetUrl ?? '', r.infoHash ?? ''];
  const clean = (value: string) => safeText(value, privateValues);
  return { title: clean(r.title), indexer: clean(r.indexer), size: r.size, seeders: r.seeders,
    leechers: r.leechers, grabs: r.grabs, age: r.age, protocol: r.protocol, tvdbId: r.tvdbId,
    tmdbId: r.tmdbId, indexerFlags: r.indexerFlags.map(clean),
    ...(includeCategories ? { categories: r.categories.map(c => ({ id: c.id, name: clean(c.name) })) } : {}),
    scope: parseReleaseCoverage(r.title) };
}
