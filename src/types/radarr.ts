import { z } from 'zod';
import { queuePageMetadataFields, trackedQueueRecordFields } from './arr-queue';

const languageSchema = z.object({ id: z.number().int().optional(), name: z.string().optional() }).passthrough();

/**
 * Radarr movie — watcher picks monitored && !hasFile && isAvailable; planner
 * uses title/year; picker sanity-checks size via sizeOnDisk/Release.size.
 */
export const movieSchema = z.object({
  id: z.number().int(),
  tmdbId: z.number().int(),
  title: z.string(),
  titleSlug: z.string(),
  year: z.number().int(),
  monitored: z.boolean(),
  hasFile: z.boolean(),
  isAvailable: z.boolean().catch(false),
  sizeOnDisk: z.number().nullable().catch(null),
  overview: z.string().nullable().optional().catch(null),
  originalLanguage: languageSchema.nullable().optional().catch(null),
  qualityProfileId: z.number().int().nullable().optional().catch(null),
  qualityProfile: z.object({ quality: z.unknown().optional(), items: z.array(z.unknown()).optional() }).passthrough().nullable().optional().catch(null),
  genres: z.array(z.string()).optional().catch([]),
});
export type Movie = z.infer<typeof movieSchema>;
export const movieListSchema = z.array(movieSchema);

/** Radarr queue-record response shape. */
export const radarrQueueRecordSchema = z
  .object({
    ...trackedQueueRecordFields,
    movieId: z.number().int().nullable().optional(),
  })
  .passthrough();
export type RadarrQueueRecord = z.infer<typeof radarrQueueRecordSchema>;

export const radarrQueuePageSchema = z
  .object({
    ...queuePageMetadataFields,
    records: z.array(radarrQueueRecordSchema),
  })
  .passthrough();
