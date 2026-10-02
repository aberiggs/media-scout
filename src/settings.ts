import { z } from 'zod';

const optionalHttpUrl = z.string().refine((value) => value === '' || (() => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch { return false; }
})(), 'must be an http(s) URL without embedded credentials or empty');
const text = z.string();
export const settingsSchema = z.object({
  version: z.literal(1),
  integrations: z.object({
    prowlarr: z.object({ url: optionalHttpUrl, apiKey: text, tvClient: text, movieClient: text }).strict(),
    sonarr: z.object({ url: optionalHttpUrl, apiKey: text }).strict(),
    radarr: z.object({ url: optionalHttpUrl, apiKey: text }).strict(),
  }).strict(),
  ai: z.object({ apiKey: text, model: text.min(1), baseUrl: optionalHttpUrl, preferences: text.trim().max(4000) }).strict(),
  monitoring: z.object({
    enabled: z.boolean(), intervalMinutes: z.number().int().min(1).max(35_791), minRetryHours: z.number().int().min(1),
    failureBackoffMinMinutes: z.number().int().min(1), failureBackoffMaxMinutes: z.number().int().min(1), queueGraceMinutes: z.number().int().min(1),
  }).strict().refine((m) => m.failureBackoffMaxMinutes >= m.failureBackoffMinMinutes, { path: ['failureBackoffMaxMinutes'], message: 'must be at least failureBackoffMinMinutes' }),
  safety: z.object({ dryRun: z.boolean(), allowOperatorActions: z.boolean() }).strict(),
}).strict();

export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  version: 1,
  integrations: { prowlarr: { url: '', apiKey: '', tvClient: '', movieClient: '' }, sonarr: { url: '', apiKey: '' }, radarr: { url: '', apiKey: '' } },
  ai: { apiKey: '', model: 'z-ai/glm-5.3-flash', baseUrl: 'https://openrouter.ai/api/v1', preferences: '' },
  monitoring: { enabled: false, intervalMinutes: 5, minRetryHours: 6, failureBackoffMinMinutes: 5, failureBackoffMaxMinutes: 60, queueGraceMinutes: 30 },
  safety: { dryRun: true, allowOperatorActions: false },
};

export function missingSettings(settings: Settings): string[] {
  const missing: string[] = [];
  const required: Array<[string, string]> = [
    ['integrations.prowlarr.url', settings.integrations.prowlarr.url], ['integrations.prowlarr.apiKey', settings.integrations.prowlarr.apiKey],
    ['integrations.prowlarr.tvClient', settings.integrations.prowlarr.tvClient], ['integrations.prowlarr.movieClient', settings.integrations.prowlarr.movieClient],
    ['integrations.sonarr.url', settings.integrations.sonarr.url], ['integrations.sonarr.apiKey', settings.integrations.sonarr.apiKey],
    ['integrations.radarr.url', settings.integrations.radarr.url], ['integrations.radarr.apiKey', settings.integrations.radarr.apiKey],
    ['ai.baseUrl', settings.ai.baseUrl], ['ai.apiKey', settings.ai.apiKey],
  ];
  for (const [key, value] of required) if (!value.trim()) missing.push(key);
  return missing;
}
