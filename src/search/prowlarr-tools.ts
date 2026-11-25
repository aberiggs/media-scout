import { z } from 'zod';

export const PROWLARR_INDEXERS_TIMEOUT_MS = 15_000;
export const PROWLARR_SEARCH_TIMEOUT_MS = 240_000;

export const prowlarrIndexerTool = {
  name: 'prowlarr_indexers',
  description: 'List configured indexers and their current enabled/cooldown availability.',
  inputSchema: z.object({}).strict(),
} as const;

export const prowlarrSearchTool = {
  name: 'prowlarr_search',
  description: 'Search enabled, non-cooling Prowlarr indexers. Results contain safe observations and opaque candidate IDs only.',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(500),
    indexerIds: z.array(z.number().int().positive()).max(100).optional(),
    categories: z.array(z.number().int().positive()).max(30).optional(),
    type: z.enum(['search', 'tvsearch', 'moviesearch', 'musicsearch', 'booksearch']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
    timeoutMs: z.number().int().min(100).max(PROWLARR_SEARCH_TIMEOUT_MS).optional(),
  }).strict(),
} as const;
export type ProwlarrSearchInput = z.infer<typeof prowlarrSearchTool.inputSchema>;
