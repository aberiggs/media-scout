import { z } from 'zod';
import { defaultSettings, settingsSchema, type Settings } from './settings';

const bootstrapSchema = z.object({
  DB_PATH: z.string().min(1).default('data/media-agent.db'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(7877),
  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

/** Legacy aliases keep the core services small; these values always come from one validated DB snapshot. */
export type Config = z.infer<typeof bootstrapSchema> & {
  settings: Settings;
  PROWLARR_URL: string; PROWLARR_API_KEY: string; PROWLARR_CLIENT_GENERAL?: string; SONARR_URL: string; SONARR_API_KEY: string;
  RADARR_URL: string; RADARR_API_KEY: string; PROWLARR_CLIENT_TV: string; PROWLARR_CLIENT_MOVIE: string;
  LLM_BASE_URL: string; LLM_API_KEY: string; LLM_MODEL: string; MEDIA_PREFERENCES: string;
  CYCLE_INTERVAL_MIN: number; MIN_RETRY_HOURS: number; FAILURE_BACKOFF_MIN: number;
  FAILURE_BACKOFF_MAX_MIN: number; QUEUE_GRACE_MIN: number; DRY_RUN: boolean; ALLOW_OPERATOR_ACTIONS: boolean;
};

export function configWithSettings(bootstrap: Pick<Config, 'DB_PATH' | 'HTTP_PORT' | 'HTTP_HOST' | 'LOG_LEVEL'>, settings: Settings): Config {
  return {
    ...bootstrap, settings,
    PROWLARR_URL: settings.integrations.prowlarr.url, PROWLARR_API_KEY: settings.integrations.prowlarr.apiKey,
    PROWLARR_CLIENT_TV: settings.integrations.prowlarr.tvClient, PROWLARR_CLIENT_MOVIE: settings.integrations.prowlarr.movieClient, PROWLARR_CLIENT_GENERAL: settings.integrations.prowlarr.generalClient ?? '',
    SONARR_URL: settings.integrations.sonarr.url, SONARR_API_KEY: settings.integrations.sonarr.apiKey,
    RADARR_URL: settings.integrations.radarr.url, RADARR_API_KEY: settings.integrations.radarr.apiKey,
    LLM_BASE_URL: settings.ai.baseUrl, LLM_API_KEY: settings.ai.apiKey, LLM_MODEL: settings.ai.model,
    MEDIA_PREFERENCES: settings.ai.preferences, CYCLE_INTERVAL_MIN: settings.monitoring.intervalMinutes,
    MIN_RETRY_HOURS: settings.monitoring.minRetryHours, FAILURE_BACKOFF_MIN: settings.monitoring.failureBackoffMinMinutes,
    FAILURE_BACKOFF_MAX_MIN: settings.monitoring.failureBackoffMaxMinutes, QUEUE_GRACE_MIN: settings.monitoring.queueGraceMinutes,
    DRY_RUN: settings.safety.dryRun, ALLOW_OPERATOR_ACTIONS: settings.safety.allowOperatorActions,
  };
}

/** Only process/bootstrap values are read here; integrations are managed in SQLite. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = bootstrapSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid bootstrap configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return configWithSettings(parsed.data, defaultSettings);
}

export function parseSettings(input: unknown) { return settingsSchema.safeParse(input); }
