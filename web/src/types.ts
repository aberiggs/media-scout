export interface Settings {
  version: 4
  integrations: { prowlarr: { url: string; apiKey: string; tvClient: string; movieClient: string }; sonarr: { url: string; apiKey: string }; radarr: { url: string; apiKey: string } }
  ai: { apiKey: string; model: string; baseUrl: string; preferences: string }
  monitoring: { enabled: boolean; allowDownloads: boolean; intervalMinutes: number; searchRetryMinutes: number; failureBackoffMinMinutes: number; failureBackoffMaxMinutes: number; queueGraceMinutes: number }
  search: { maxDecisions: number; maxSearches: number; deadlineMinutes: number }
  safety: { dryRun: boolean }
}
export interface SettingsStatus { ready: boolean; missing: string[]; monitoringEnabled: boolean; cycleRunning: boolean }
export interface SettingsEnvelope { settings: Settings; status: SettingsStatus }
export const defaults: Settings = { version: 4, integrations: { prowlarr: { url: '', apiKey: '', tvClient: '', movieClient: '' }, sonarr: { url: '', apiKey: '' }, radarr: { url: '', apiKey: '' } }, ai: { apiKey: '', model: '', baseUrl: '', preferences: '' }, monitoring: { enabled: false, allowDownloads: false, intervalMinutes: 5, searchRetryMinutes: 30, failureBackoffMinMinutes: 5, failureBackoffMaxMinutes: 60, queueGraceMinutes: 30 }, search: { maxDecisions: 100, maxSearches: 100, deadlineMinutes: 30 }, safety: { dryRun: true } }
export function mergeSettings(input: Settings): Settings { return { ...defaults, ...input, integrations: { prowlarr: { ...defaults.integrations.prowlarr, ...input.integrations?.prowlarr }, sonarr: { ...defaults.integrations.sonarr, ...input.integrations?.sonarr }, radarr: { ...defaults.integrations.radarr, ...input.integrations?.radarr } }, ai: { ...defaults.ai, ...input.ai }, monitoring: { ...defaults.monitoring, ...input.monitoring }, search: { ...defaults.search, ...input.search }, safety: { ...defaults.safety, ...input.safety } } }
