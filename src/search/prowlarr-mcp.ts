import { McpServer } from '@modelcontextprotocol/server';
import type { SearchRuntime } from './runtime';
import { prowlarrIndexerTool, prowlarrSearchTool } from './prowlarr-tools';

export function createProwlarrMcpServer(runtime: SearchRuntime, token: string): McpServer {
  const server = new McpServer({ name: 'media-scout-prowlarr', version: '1.0.0' });
  server.registerTool(prowlarrIndexerTool.name, {
    description: prowlarrIndexerTool.description,
    inputSchema: prowlarrIndexerTool.inputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (_args, ctx) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await runtime.prowlarrIndexerDiscovery(token, ctx.mcpReq.signal)) }] }; }
    catch (error) { return { content: [{ type: 'text', text: error instanceof Error && error.message === 'Prowlarr discovery failed: timed out' ? 'Prowlarr indexer discovery timed out.' : 'Prowlarr indexer discovery unavailable.' }], isError: true }; }
  });
  server.registerTool(prowlarrSearchTool.name, {
    description: prowlarrSearchTool.description,
    inputSchema: prowlarrSearchTool.inputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args, ctx) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await runtime.prowlarrSearch(token, args, ctx.mcpReq.signal)) }] }; }
    catch (error) {
      const known = error instanceof Error && error.message === 'Prowlarr search failed: timed out' ? 'Prowlarr search timed out.'
        : error instanceof Error && ['provider-cooldown', 'no-healthy-indexers', 'prowlarr-unavailable'].includes(error.message) ? error.message : 'Prowlarr search unavailable.';
      return { content: [{ type: 'text', text: known }], isError: true };
    }
  });
  return server;
}
