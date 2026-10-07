import { z } from 'zod';
import { createHash } from 'node:crypto';

/** Prowlarr DownloadProtocol enum (openapi: "unknown" | "usenet" | "torrent"). */
export const downloadProtocolSchema = z.enum(['unknown', 'usenet', 'torrent']);
export type DownloadProtocol = z.infer<typeof downloadProtocolSchema>;

/** Newznab category on a release — the agent filters on id (5070/5000/2000). */
export const releaseCategorySchema = z.object({
  id: z.number().int(),
  name: z.string().catch(''),
});

/**
 * ReleaseResource (Prowlarr openapi #/components/schemas/ReleaseResource).
 * Declares only consumed fields — zod strips unknowns (I8 tolerance). Flaky
 * numerics coerce to null instead of failing the boundary. Recorded LIVE at
 * P7 (2026-10-01): rows OMIT null fields entirely (never JSON null) —
 * magnetUrl/infoHash/files/grabs/subGroup/downloadClientId are ABSENT on live
 * rows, downloadUrl is always present. Omitted-vs-null is why nullable fields
 * carry .catch(null): it coerces the absent (undefined) key to null so
 * consumers keep a string|null contract. `id` is never sent live and has
 * zero consumers — not declared.
 */
export const releaseSchema = z.object({
  guid: z.string(),
  age: z.number().int().catch(0),
  size: z.number().nullable().catch(null),
  files: z.number().int().nullable().catch(null),
  grabs: z.number().int().nullable().catch(null),
  indexerId: z.number().int(),
  indexer: z.string(),
  subGroup: z.string().nullable().catch(null),
  title: z.string(),
  tvdbId: z.number().int().nullable().catch(null),
  tmdbId: z.number().int().nullable().catch(null),
  publishDate: z.string(),
  downloadUrl: z.string().nullable().catch(null),
  indexerFlags: z.array(z.string()).catch([]),
  categories: z.array(releaseCategorySchema).catch([]),
  magnetUrl: z.string().nullable().catch(null),
  infoHash: z.string().nullable().catch(null),
  seeders: z.number().int().nullable().catch(null),
  leechers: z.number().int().nullable().catch(null),
  protocol: downloadProtocolSchema,
  downloadClientId: z.number().int().nullable().catch(null),
});
export type Release = z.infer<typeof releaseSchema>;
export const releaseListSchema = z.array(releaseSchema);

/**
 * Outbound grab body: POST /api/v1/search with a single cached release.
 * downloadClientId is required — it overrides Prowlarr's client selection and
 * routes the push to the right *arr category (D6). A grab without it would
 * land on Prowlarr's default client, so the schema rejects that.
 */
export const grabRequestSchema = z.object({
  indexerId: z.number().int(),
  guid: z.string(),
  downloadClientId: z.number().int(),
});
export type GrabRequest = z.infer<typeof grabRequestSchema>;

/** IndexerStatusResource — per-indexer backoff signal for I5. Live Prowlarr rows
 * carry NO `id` (recorded live at P7, 2026-09-30); consumers read indexerId + disabledTill only. */
export const indexerStatusSchema = z.object({
  indexerId: z.number().int(),
  disabledTill: z.string().nullable(),
  mostRecentFailure: z.string().nullable().catch(null),
  initialFailure: z.string().nullable().catch(null),
});

/** Prowlarr configured indexer entry — the runner builds the healthy allowlist from these (I5). */
export const indexerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  enable: z.boolean().catch(false),
});
export type Indexer = z.infer<typeof indexerSchema>;
export const indexerListSchema = z.array(indexerSchema);
export type IndexerStatus = z.infer<typeof indexerStatusSchema>;
export const indexerStatusListSchema = z.array(indexerStatusSchema);

/** Category override on a Prowlarr download-client entry; clientCategory is the qBittorrent label. */
export const downloadClientCategorySchema = z.object({
  clientCategory: z.string().nullable(),
  categories: z.array(z.number().int()).nullable().catch(null),
});

/** Stable canonical JSON for provider field values; object property order is irrelevant. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalJson(item)]));
  }
  return value;
}

function downloadClientRoutingDigest(raw: Record<string, unknown>, parsed: {
  supportsCategories: boolean;
  categories: z.infer<typeof downloadClientCategorySchema>[];
}): string | null {
  const fields = raw.fields;
  const implementation = raw.implementation;
  const configContract = raw.configContract;
  if (typeof implementation !== 'string' || !implementation || typeof configContract !== 'string' || !configContract || !Array.isArray(fields) || fields.length === 0) return null;
  const providerFields: Array<{ name: string; value: unknown }> = [];
  for (const field of fields) {
    if (typeof field !== 'object' || field === null || Array.isArray(field)) return null;
    const record = field as Record<string, unknown>;
    if (typeof record.name !== 'string' || !record.name.trim()) return null;
    const value = record.value == null ? null : record.value;
    providerFields.push({ name: record.name, value: canonicalJson(value) });
  }
  providerFields.sort((a, b) => compareCanonical(a.name, b.name) || compareCanonical(JSON.stringify(a.value), JSON.stringify(b.value)));
  const categories = parsed.categories.map(({ clientCategory, categories: ids }) => ({
    clientCategory,
    categories: ids === null ? null : [...ids].sort((a, b) => a - b),
  })).sort((a, b) => compareCanonical(JSON.stringify(a), JSON.stringify(b)));
  const source = JSON.stringify({ implementation, configContract, fields: providerFields, supportsCategories: parsed.supportsCategories, categories });
  return createHash('sha256').update(source).digest('hex');
}

function compareCanonical(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Prowlarr download-client entry — resolved by name to route grabs (D6). */
export const downloadClientSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  enable: z.boolean().catch(false),
  protocol: downloadProtocolSchema,
  supportsCategories: z.boolean().catch(false),
  categories: z.array(downloadClientCategorySchema).catch([]),
}).passthrough().transform((raw) => {
  const { id, name, enable, protocol, supportsCategories, categories } = raw;
  const routingDigest = downloadClientRoutingDigest(raw as Record<string, unknown>, { supportsCategories, categories });
  return { id, name, enable, protocol, supportsCategories, categories, routingDigest };
});
export type DownloadClient = z.infer<typeof downloadClientSchema>;
export const downloadClientListSchema = z.array(downloadClientSchema);
