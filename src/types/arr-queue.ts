import { z } from 'zod';

/** Shared nullable queue fields used by the version-pinned Sonarr/Radarr resources. */
export const trackedQueueRecordFields = {
  id: z.number().int().nullable().optional(),
  downloadId: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  trackedDownloadStatus: z.string().nullable().optional(),
  trackedDownloadState: z.string().nullable().optional(),
  protocol: z.string().nullable().optional(),
  size: z.number().nullable().catch(null).optional(),
  sizeleft: z.number().nullable().catch(null).optional(),
  timeleft: z.string().nullable().optional(),
  statusMessages: z
    .array(
      z
        .object({
          title: z.string().nullable().optional(),
          messages: z.array(z.string()).nullable().optional(),
        })
        .passthrough(),
    )
    .nullable()
    .optional(),
  errorMessage: z.string().nullable().optional(),
};

export const queuePageMetadataFields = {
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalRecords: z.number().int().nonnegative(),
};
