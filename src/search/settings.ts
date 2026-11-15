import { z } from 'zod';

const serviceUrl = z.string().refine((value) => value === '' || (() => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
})(), 'must be an http(s) URL without embedded credentials or empty');
const text = z.string();
export const settingsSchema = z.object({
  version: z.literal(2),
  integrations: z.object({
    prowlarr: z.object({ url: serviceUrl, apiKey: text, tvClient: text, movieClient: text }).strict(),
    sonarr: z.object({ url: serviceUrl, apiKey: text }).strict(),
    radarr: z.object({ url: serviceUrl, apiKey: text }).strict(),
  }).strict(),
  ai: z.object({ apiKey: text, model: text.min(1), baseUrl: serviceUrl, preferences: text.trim().max(4000) }).strict(),
  monitoring: z.object({
    enabled: z.boolean(), intervalMinutes: z.number().int().min(1).max(35_791), minRetryHours: z.number().int().min(1).max(8760),
    failureBackoffMinMinutes: z.number().int().min(1).max(35_791), failureBackoffMaxMinutes: z.number().int().min(1).max(35_791), queueGraceMinutes: z.number().int().min(1).max(1440),
  }).strict().refine((value) => value.failureBackoffMaxMinutes >= value.failureBackoffMinMinutes, { path: ['failureBackoffMaxMinutes'], message: 'must be at least failureBackoffMinMinutes' }),
  search: z.object({ maxDecisions: z.number().int().min(1).max(20), maxSearches: z.number().int().min(1).max(12), deadlineMinutes: z.number().int().min(1).max(10) }).strict(),
  safety: z.object({ dryRun: z.boolean() }).strict(),
}).strict();

export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  version: 2,
  integrations: { prowlarr: { url: '', apiKey: '', tvClient: '', movieClient: '' }, sonarr: { url: '', apiKey: '' }, radarr: { url: '', apiKey: '' } },
  ai: { apiKey: '', model: 'z-ai/glm-5.3-flash', baseUrl: 'https://openrouter.ai/api/v1', preferences: '' },
  monitoring: { enabled: false, intervalMinutes: 5, minRetryHours: 6, failureBackoffMinMinutes: 5, failureBackoffMaxMinutes: 60, queueGraceMinutes: 30 },
  search: { maxDecisions: 20, maxSearches: 12, deadlineMinutes: 10 }, safety: { dryRun: true },
};

export function missingSettings(settings: Settings): string[] {
  const required: Array<[string, string]> = [
    ['integrations.prowlarr.url', settings.integrations.prowlarr.url],
    ['integrations.prowlarr.apiKey', settings.integrations.prowlarr.apiKey],
    ['ai.baseUrl', settings.ai.baseUrl], ['ai.apiKey', settings.ai.apiKey], ['ai.model', settings.ai.model],
  ];
  return required.filter(([, value]) => !value.trim()).map(([key]) => key);
}
