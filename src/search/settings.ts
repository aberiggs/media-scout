import { z } from 'zod';

const serviceUrl = z.string().refine((value) => value === '' || (() => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
})(), 'must be an http(s) URL without embedded credentials or empty');
const text = z.string();
export const settingsSchema = z.object({
  version: z.literal(4),
  integrations: z.object({
    prowlarr: z.object({ url: serviceUrl, apiKey: text, tvClient: text, movieClient: text }).strict(),
    sonarr: z.object({ url: serviceUrl, apiKey: text }).strict(),
    radarr: z.object({ url: serviceUrl, apiKey: text }).strict(),
  }).strict(),
  ai: z.object({ apiKey: text, model: text.min(1), baseUrl: serviceUrl, preferences: text.trim().max(4000) }).strict(),
  monitoring: z.object({
    enabled: z.boolean(), allowDownloads: z.boolean(), intervalMinutes: z.number().int().min(1).max(35_791), searchRetryMinutes: z.number().int().min(1).max(525_600),
    failureBackoffMinMinutes: z.number().int().min(1).max(35_791), failureBackoffMaxMinutes: z.number().int().min(1).max(35_791), queueGraceMinutes: z.number().int().min(1).max(1440),
  }).strict().refine((value) => value.failureBackoffMaxMinutes >= value.failureBackoffMinMinutes, { path: ['failureBackoffMaxMinutes'], message: 'must be at least failureBackoffMinMinutes' }),
  search: z.object({ maxDecisions: z.number().int().min(1).max(100), maxSearches: z.number().int().min(1).max(100), deadlineMinutes: z.number().int().min(1).max(30) }).strict(),
  safety: z.object({ dryRun: z.boolean() }).strict(),
}).strict();

export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  version: 4,
  integrations: { prowlarr: { url: '', apiKey: '', tvClient: '', movieClient: '' }, sonarr: { url: '', apiKey: '' }, radarr: { url: '', apiKey: '' } },
  ai: { apiKey: '', model: 'openai/gpt-6.1-sol', baseUrl: 'https://openrouter.ai/api/v1', preferences: '' },
  monitoring: { enabled: false, allowDownloads: false, intervalMinutes: 5, searchRetryMinutes: 30, failureBackoffMinMinutes: 5, failureBackoffMaxMinutes: 60, queueGraceMinutes: 30 },
  search: { maxDecisions: 100, maxSearches: 100, deadlineMinutes: 30 }, safety: { dryRun: true },
};

export function migrateSettings(value: unknown): { migrated: boolean; settings: Settings } {
  const current = settingsSchema.safeParse(value);
  if (current.success) return { migrated: false, settings: current.data };
  if (!value || typeof value !== 'object' || ![2, 3].includes((value as { version?: number }).version ?? -1)) {
    throw new Error('Saved application settings are invalid');
  }
  const legacy = value as Record<string, any>;
  const hours = legacy.monitoring?.minRetryHours;
  const searchRetryMinutes = legacy.version === 2 ? hours === 6 ? 30 : typeof hours === 'number' ? hours * 60 : 30 : legacy.monitoring?.searchRetryMinutes ?? 30;
  const { minRetryHours: _legacyRetry, ...monitoring } = legacy.monitoring ?? {};
  const migrated = settingsSchema.safeParse({ ...legacy, version: 4, monitoring: { ...monitoring, allowDownloads: false, searchRetryMinutes } });
  if (!migrated.success) throw new Error('Saved application settings are invalid');
  return { migrated: true, settings: migrated.data };
}

export function missingSettings(settings: Settings): string[] {
  const required: Array<[string, string]> = [
    ['integrations.prowlarr.url', settings.integrations.prowlarr.url],
    ['integrations.prowlarr.apiKey', settings.integrations.prowlarr.apiKey],
    ['ai.baseUrl', settings.ai.baseUrl], ['ai.apiKey', settings.ai.apiKey], ['ai.model', settings.ai.model],
  ];
  return required.filter(([, value]) => !value.trim()).map(([key]) => key);
}
