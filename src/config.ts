import { z } from 'zod';

/** Env vars must be http(s) URLs — *arr/Prowlarr never speak anything else on a homelab. */
const httpUrl = z.string().regex(/^https?:\/\//, 'must be an http(s) URL');

/**
 * Env booleans arrive as strings; only explicit true/false/1/0 are accepted so a
 * typo can never silently flip DRY_RUN.
 */
const boolFromEnv = z
  .preprocess((value) => {
    if (typeof value === 'string') {
      const s = value.trim().toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      return Symbol.for('invalid-bool');
    }
    return value;
  }, z.boolean({ error: 'must be "true" or "false"' }))
  .default(true);

const configSchema = z.object({
  PROWLARR_URL: httpUrl,
  PROWLARR_API_KEY: z.string().min(1),
  SONARR_URL: httpUrl,
  SONARR_API_KEY: z.string().min(1),
  RADARR_URL: httpUrl,
  RADARR_API_KEY: z.string().min(1),
  PROWLARR_CLIENT_TV: z.string().min(1),
  PROWLARR_CLIENT_MOVIE: z.string().min(1),
  LLM_BASE_URL: httpUrl.default('https://openrouter.ai/api/v1'),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1).default('z-ai/glm-5.3-flash'),
  MEDIA_PREFERENCES: z.string().trim().max(4000).default(''),
  CYCLE_INTERVAL_MIN: z.coerce.number().int().min(1).default(5),
  MIN_RETRY_HOURS: z.coerce.number().int().min(1).default(6),
  FAILURE_BACKOFF_MIN: z.coerce.number().int().min(1).default(5),
  FAILURE_BACKOFF_MAX_MIN: z.coerce.number().int().min(1).default(60),
  QUEUE_GRACE_MIN: z.coerce.number().int().min(1).default(30),
  DRY_RUN: boolFromEnv,
  ALLOW_OPERATOR_ACTIONS: boolFromEnv.default(false),
  DB_PATH: z.string().min(1).default('data/media-agent.db'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(7877),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
}).refine(
  (config) => config.FAILURE_BACKOFF_MAX_MIN >= config.FAILURE_BACKOFF_MIN,
  {
    path: ['FAILURE_BACKOFF_MAX_MIN'],
    message: 'FAILURE_BACKOFF_MAX_MIN must be at least FAILURE_BACKOFF_MIN',
  },
);

export type Config = z.infer<typeof configSchema>;

/** Single source of env truth — no other module reads process.env. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
