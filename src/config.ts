import { z } from 'zod';
import { canonicalEndpoint } from './search/research-mcp';

const bootstrapSchema = z.object({
  DB_PATH: z.string().min(1).default('data/media-scout-search.db'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(7877),
  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  RESEARCH_MCP_ENDPOINTS: z.string().default(''),
});
export type Config = z.infer<typeof bootstrapSchema>;
/** Only bootstrap values come from the environment; connections/preferences live in Settings. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = bootstrapSchema.safeParse(env);
  if (!parsed.success) throw new Error('Invalid bootstrap configuration');
  const endpoints = parsed.data.RESEARCH_MCP_ENDPOINTS.split(',').map(value => value.trim()).filter(Boolean);
  try { endpoints.forEach(canonicalEndpoint); }
  catch { throw new Error('Invalid bootstrap configuration'); }
  return { ...parsed.data, RESEARCH_MCP_ENDPOINTS: [...new Set(endpoints)].join(',') };
}
