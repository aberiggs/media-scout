import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ApiError } from '../http';
import { searchRequestSchema, activityStatusSchema, submissionRequestSchema } from './contracts';
import type { SearchRuntime } from './runtime';

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const safeError = (error: unknown): string => {
  if (error instanceof ApiError) return `Upstream request failed (${error.status > 0 ? `HTTP ${error.status}` : 'network or timeout failure'}${error.retryAfter === undefined ? '' : `; retry after ${error.retryAfter}s`})`;
  if (error instanceof z.ZodError) return 'Upstream response was invalid';
  if (error instanceof Error) {
    const allow = ['settings-incomplete', 'prowlarr-unavailable', 'runtime-closed', 'target-not-eligible', 'target-held'];
    if (allow.includes(error.message)) return error.message;
    if (error.message.startsWith('LLM ')) return 'LLM request failed';
  }
  return 'Operation failed';
};
const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (error) { throw new Error(safeError(error)); }
};

export function createSearchMcpServer(runtime: SearchRuntime): McpServer {
  const server = new McpServer({ name: 'media-agent', version: '0.2.0' });
  server.registerTool('ma_status', { description: 'Saved search service readiness and safety status.', annotations: { readOnlyHint: true } }, async () => json({ ready: runtime.missingSettings().length === 0, missing: runtime.missingSettings(), ...runtime.automationStatus() }));
  server.registerTool('ma_search_v2', { description: 'Start a bounded release search.', inputSchema: searchRequestSchema, annotations: { readOnlyHint: true, openWorldHint: true } }, async request => guarded(async () => json(runtime.startSearch(request))));
  server.registerTool('ma_search_status_v2', { description: 'Read stored search status without contacting upstream services.', inputSchema: z.object({ searchId: z.string().trim().min(1) }).strict(), annotations: { readOnlyHint: true } }, async ({ searchId }) => {
    const result = await runtime.getSearch(searchId);
    return result ? json(result) : { ...json({ error: 'Search not found', status: 404 }), isError: true };
  });
  server.registerTool('ma_activity_v2', { description: 'List filtered stored search history and submission outcomes.', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional(), q: z.string().max(200).optional(), status: activityStatusSchema.optional(), source: z.enum(['manual', 'automation']).optional(), kind: z.enum(['tv', 'movie', 'other']).optional(), createdAtFrom: z.string().max(40).datetime({ offset: true }).optional(), createdAtTo: z.string().max(40).datetime({ offset: true }).optional() }).strict().refine(q => !q.createdAtFrom || !q.createdAtTo || Date.parse(q.createdAtFrom) <= Date.parse(q.createdAtTo), { message: 'createdAtFrom must be on or before createdAtTo' }), annotations: { readOnlyHint: true } }, async query => json(runtime.activity(query)));
  server.registerTool('ma_download_clients_v2', { description: 'List enabled safe download clients.', annotations: { readOnlyHint: true, openWorldHint: true } }, async () => guarded(async () => json(await runtime.downloadClients())));
  server.registerTool('ma_submit_v2', { description: 'Explicitly submit a selected option; host approval required.', inputSchema: submissionRequestSchema, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async request => guarded(async () => json(await runtime.submit(request))));
  server.registerTool('ma_automation_status_v2', { description: 'Read saved automation settings and observations only.', annotations: { readOnlyHint: true } }, async () => json(runtime.automationStatus()));
  server.registerTool('ma_automation_poll_v2', { description: 'Refresh observations and possibly run download automation; host approval required.', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async () => guarded(async () => json(await runtime.poll())));
  server.registerTool('ma_automation_search_v2', { description: 'Start a search for an eligible Arr target.', inputSchema: z.object({ targetId: z.string().trim().min(1) }).strict(), annotations: { readOnlyHint: true, openWorldHint: true } }, async ({ targetId }) => guarded(async () => json(await runtime.startArrSearch(targetId))));
  return server;
}
