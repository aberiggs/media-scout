import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ApiError } from '../http';
import { searchRequestSchema, activityStatusSchema } from './contracts';
import type { ActivityQuery, ArrObservationPass, PublicSearchStatus, SearchRuntime } from './runtime';

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const safeError = (error: unknown): string => {
  if (error instanceof ApiError) return `Upstream request failed (${error.status > 0 ? `HTTP ${error.status}` : 'network or timeout failure'}${error.retryAfter === undefined ? '' : `; retry after ${error.retryAfter}s`})`;
  if (error instanceof z.ZodError) return 'Upstream response was invalid';
  if (error instanceof Error) {
    const allow = ['settings-incomplete', 'prowlarr-unavailable', 'runtime-closed', 'daemon-mcp-unavailable'];
    if (allow.includes(error.message)) return error.message;
    if (error.message.startsWith('LLM ')) return 'LLM request failed';
  }
  return 'Operation failed';
};
const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (error) { throw new Error(safeError(error)); }
};

export interface SearchDomain {
  missingSettings(): string[] | Promise<string[]>;
  automationStatus(): unknown | Promise<unknown>;
  startSearch(request: unknown): Promise<{ searchId: string; status: 'queued' }> | { searchId: string; status: 'queued' };
  getSearch(searchId: string): Promise<PublicSearchStatus | null> | PublicSearchStatus | null;
  activity(query: ActivityQuery): unknown | Promise<unknown>;
  poll(): Promise<ArrObservationPass> | ArrObservationPass;
}
export function createSearchMcpServer(runtime: SearchDomain | SearchRuntime): McpServer {
  const server = new McpServer({ name: 'media-agent', version: '0.2.0' });
  server.registerTool('ma_status', { description: 'Saved search service readiness and safety status.', annotations: { readOnlyHint: true } }, async () => guarded(async () => {
    const [missing, automation] = await Promise.all([runtime.missingSettings(), runtime.automationStatus()]);
    return json({ ready: missing.length === 0, missing, ...(automation as object) });
  }));
  server.registerTool('ma_search_v2', { description: 'Start a bounded release search.', inputSchema: searchRequestSchema, annotations: { readOnlyHint: true, openWorldHint: true } }, async request => guarded(async () => json(await runtime.startSearch(request))));
  server.registerTool('ma_search_status_v2', { description: 'Read stored search status without contacting upstream services.', inputSchema: z.object({ searchId: z.string().trim().min(1) }).strict(), annotations: { readOnlyHint: true } }, async ({ searchId }) => {
    const result = await runtime.getSearch(searchId);
    return result ? json(result) : { ...json({ error: 'Search not found', status: 404 }), isError: true };
  });
  server.registerTool('ma_activity_v2', { description: 'List filtered stored search history and submission outcomes.', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1_000_000).optional(), q: z.string().max(200).optional(), status: activityStatusSchema.optional(), source: z.enum(['manual', 'automation', 'arr']).optional(), kind: z.enum(['tv', 'movie', 'other']).optional(), createdAtFrom: z.string().max(40).datetime({ offset: true }).optional(), createdAtTo: z.string().max(40).datetime({ offset: true }).optional() }).strict().refine(q => !q.createdAtFrom || !q.createdAtTo || Date.parse(q.createdAtFrom) <= Date.parse(q.createdAtTo), { message: 'createdAtFrom must be on or before createdAtTo' }), annotations: { readOnlyHint: true } }, async query => guarded(async () => json(await runtime.activity(query))));
   server.registerTool('ma_automation_status_v2', { description: 'Read saved automation settings and observations only.', annotations: { readOnlyHint: true } }, async () => guarded(async () => json(await runtime.automationStatus())));
   server.registerTool('ma_automation_poll_v2', { description: 'Refresh read-only Arr observations; acquisition automation is deferred.', annotations: { readOnlyHint: true } }, async () => guarded(async () => json(await runtime.poll())));
  return server;
}
