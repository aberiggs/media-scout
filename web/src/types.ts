export interface Settings {
  version: 1
  integrations: {
    prowlarr: { url: string; apiKey: string; tvClient: string; movieClient: string; generalClient: string }
    sonarr: { url: string; apiKey: string }
    radarr: { url: string; apiKey: string }
  }
  ai: { apiKey: string; model: string; baseUrl: string; preferences: string; searchSystemPrompt: string }
  monitoring: {
    enabled: boolean
    intervalMinutes: number
    minRetryHours: number
    failureBackoffMinMinutes: number
    failureBackoffMaxMinutes: number
    queueGraceMinutes: number
  }
  safety: { dryRun: boolean; allowOperatorActions: boolean }
}

export interface SettingsStatus {
  ready: boolean
  missing: string[]
  monitoringEnabled: boolean
  cycleRunning: boolean
}

export interface SettingsEnvelope {
  settings: Settings
  status: SettingsStatus
}

export const defaults: Settings = {
  version: 1,
  integrations: {
    prowlarr: { url: '', apiKey: '', tvClient: '', movieClient: '', generalClient: '' },
    sonarr: { url: '', apiKey: '' },
    radarr: { url: '', apiKey: '' },
  },
  ai: {
    apiKey: '',
    model: 'z-ai/glm-5.3-flash',
    baseUrl: 'https://openrouter.ai/api/v1',
    preferences: '',
    searchSystemPrompt: '',
  },
  monitoring: {
    enabled: false,
    intervalMinutes: 5,
    minRetryHours: 6,
    failureBackoffMinMinutes: 5,
    failureBackoffMaxMinutes: 60,
    queueGraceMinutes: 30,
  },
  safety: { dryRun: true, allowOperatorActions: false },
}

export function mergeSettings(input: Settings): Settings {
  return {
    ...defaults,
    ...input,
    integrations: {
      prowlarr: { ...defaults.integrations.prowlarr, ...input.integrations?.prowlarr },
      sonarr: { ...defaults.integrations.sonarr, ...input.integrations?.sonarr },
      radarr: { ...defaults.integrations.radarr, ...input.integrations?.radarr },
    },
    ai: { ...defaults.ai, ...input.ai },
    monitoring: { ...defaults.monitoring, ...input.monitoring },
    safety: { ...defaults.safety, ...input.safety },
  }
}
