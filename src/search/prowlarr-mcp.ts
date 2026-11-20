import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SearchRuntime } from './runtime';

export function createProwlarrMcpServer(runtime: SearchRuntime, token: string): McpServer {
  const server = new McpServer({ name: 'media-scout-prowlarr', version: '1.0.0' });
  server.registerTool('prowlarr_indexers', {
    description: 'List configured indexers and their current enabled/cooldown availability.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (_args, ctx) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await runtime.prowlarrIndexerDiscovery(token, ctx.mcpReq.signal)) }] }; }
    catch { return { content: [{ type: 'text', text: 'Prowlarr indexer discovery unavailable.' }], isError: true }; }
  });
  server.registerTool('prowlarr_search', {
    description: 'Search enabled, non-cooling Prowlarr indexers. Results contain safe observations and opaque candidate IDs only.',
    inputSchema: z.object({
      query: z.string().trim().min(1).max(500),
      indexerIds: z.array(z.number().int().positive()).max(100).optional(),
      categories: z.array(z.number().int().positive()).max(30).optional(),
      type: z.enum(['search', 'tvsearch', 'moviesearch', 'musicsearch', 'booksearch']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args, ctx) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await runtime.prowlarrSearch(token, args, ctx.mcpReq.signal)) }] }; }
    catch (error) {
      const known = error instanceof Error && ['provider-cooldown', 'no-healthy-indexers', 'prowlarr-unavailable'].includes(error.message) ? error.message : 'Prowlarr search unavailable.';
      return { content: [{ type: 'text', text: known }], isError: true };
    }
  });
  return server;
}
