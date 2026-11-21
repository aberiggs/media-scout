import { z } from 'zod';
import { queuePageMetadataFields, trackedQueueRecordFields } from './arr-queue';

/** Sonarr seriesType — "anime" episodes carry absoluteEpisodeNumber, the parser's match target. */
export const seriesTypeSchema = z.enum(['standard', 'anime', 'daily']);
export type SeriesType = z.infer<typeof seriesTypeSchema>;

export const seasonSchema = z.object({
  seasonNumber: z.number().int(),
  monitored: z.boolean(),
  statistics: z
    .object({
      episodeFileCount: z.number().int().nullable().catch(null),
      totalEpisodeCount: z.number().int().nullable().catch(null),
      nextAiring: z.string().nullable().optional().catch(null),
      previousAiring: z.string().nullable().optional().catch(null),
    })
    .nullable()
    .catch(null),
});

/** Alternate titles feed the planner's query variants (D2 rationale: they break deterministic filters). */
export const alternateTitleSchema = z.object({
  title: z.string(),
  seasonNumber: z.number().int().nullish().catch(undefined),
});

const languageSchema = z.object({ id: z.number().int().optional(), name: z.string().optional() }).passthrough();
const profileContextSchema = z.object({ quality: z.unknown().optional(), items: z.array(z.unknown()).optional() }).passthrough();

export const seriesSchema = z.object({
  id: z.number().int(),
  tvdbId: z.number().int(),
  title: z.string(),
  titleSlug: z.string(),
  seriesType: seriesTypeSchema,
  monitored: z.boolean(),
  status: z.enum(['continuing', 'ended']).nullable().optional().catch(null),
  seasons: z.array(seasonSchema).catch([]),
  alternateTitles: z.array(alternateTitleSchema).catch([]),
  overview: z.string().nullable().optional().catch(null),
  originalLanguage: languageSchema.nullable().optional().catch(null),
  qualityProfileId: z.number().int().nullable().optional().catch(null),
  qualityProfile: profileContextSchema.nullable().optional().catch(null),
  genres: z.array(z.string()).optional().catch([]),
});
export type Series = z.infer<typeof seriesSchema>;
export const seriesListSchema = z.array(seriesSchema);

/**
 * Sonarr episode. absoluteEpisodeNumber exists only for anime series and may
 * be missing when TVDB lacks the absolute mapping — coerces to null so the
 * parser can't mistake absence for 0 and the guardrail flags it (I1/I2).
 */
export const episodeSchema = z.object({
  id: z.number().int(),
  seriesId: z.number().int(),
  seasonNumber: z.number().int(),
  episodeNumber: z.number().int(),
  absoluteEpisodeNumber: z.number().int().nullable().catch(null),
  title: z.string().catch(''),
  airDate: z.string().nullable().catch(null),
  airDateUtc: z.string().nullable().optional().catch(null),
  finaleType: z.string().nullable().optional().catch(null),
  monitored: z.boolean(),
  hasFile: z.boolean(),
  overview: z.string().nullable().optional().catch(null),
  originalLanguage: languageSchema.nullable().optional().catch(null),
});
export type Episode = z.infer<typeof episodeSchema>;
export const episodeListSchema = z.array(episodeSchema);

/** Sonarr queue-record response shape. */
export const sonarrQueueRecordSchema = z
  .object({
    ...trackedQueueRecordFields,
    seriesId: z.number().int().nullable().optional(),
    episodeId: z.number().int().nullable().optional(),
    seasonNumber: z.number().int().nullable().optional(),
  })
  .passthrough();
export type SonarrQueueRecord = z.infer<typeof sonarrQueueRecordSchema>;

export const sonarrQueuePageSchema = z
  .object({
    ...queuePageMetadataFields,
    records: z.array(sonarrQueueRecordSchema),
  })
  .passthrough();
