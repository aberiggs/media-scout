import { z } from 'zod';
import { queuePageMetadataFields, trackedQueueRecordFields } from './arr-queue';

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
