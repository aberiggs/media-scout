import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { State } from '../src/core/state';
import { defaultSettings, missingSettings, settingsSchema } from '../src/settings';

describe('persisted UI settings', () => {
  it('boots with validated empty integration defaults without requiring env or database writes', () => {
    const state = State.open(':memory:');
    const settings = state.getSettings();
    expect(settings).toEqual(defaultSettings);
    expect(settingsSchema.safeParse(settings).success).toBe(true);
    expect(settings.monitoring.enabled).toBe(false);
    expect(settings.safety.dryRun).toBe(true);
    expect(settings.generalSearch).toEqual({ maxQueries: 6, maxCandidates: 200, maxAiCalls: 12, batchSize: 20, displayLimit: 40, hideZeroSeeders: true });
    expect(missingSettings(settings)).toContain('integrations.sonarr.apiKey');
    expect(missingSettings(settings)).not.toContain('integrations.prowlarr.generalClient');
    state.close();
  });

  it('persists the versioned complete document across a database restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'media-scout-settings-'));
    const path = join(dir, 'settings.db');
    const configured = { ...defaultSettings, integrations: {
      prowlarr: { url: 'http://prowlarr.local:9696', apiKey: 'secret-prowlarr', tvClient: 'tv', movieClient: 'movie' },
      sonarr: { url: 'http://sonarr.local:8989', apiKey: 'secret-sonarr' }, radarr: { url: 'http://radarr.local:7878', apiKey: 'secret-radarr' },
    }, ai: { ...defaultSettings.ai, apiKey: 'secret-ai', preferences: 'Prefer HD' }, monitoring: { ...defaultSettings.monitoring, enabled: true, intervalMinutes: 17 } };
    const first = State.open(path);
    first.saveSettings(configured);
    first.close();
    const second = State.open(path);
    expect(second.getSettings()).toEqual({ ...configured, integrations: { ...configured.integrations, prowlarr: { ...configured.integrations.prowlarr, generalClient: '' } } });
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('validates complete documents including URL, preference limit, and backoff relation', () => {
    const badUrl = structuredClone(defaultSettings);
    badUrl.integrations.prowlarr.url = 'ftp://invalid';
    expect(settingsSchema.safeParse(badUrl).success).toBe(false);
    const longPreferences = structuredClone(defaultSettings);
    longPreferences.ai.preferences = 'x'.repeat(4001);
    expect(settingsSchema.safeParse(longPreferences).success).toBe(false);
    const invertedBackoff = structuredClone(defaultSettings);
    invertedBackoff.monitoring.failureBackoffMinMinutes = 61;
    expect(settingsSchema.safeParse(invertedBackoff).success).toBe(false);
  });

  it('migrates version-one stored settings without a general destination to the empty default', () => {
    const legacy = structuredClone(defaultSettings) as Record<string, any>;
    delete legacy.integrations.prowlarr.generalClient;
    expect(settingsSchema.parse(legacy).integrations.prowlarr.generalClient).toBe('');
  });

  it('defaults general-search budgets on older version-one settings and validates their bounds', () => {
    const legacy = structuredClone(defaultSettings) as Record<string, any>;
    delete legacy.generalSearch;
    expect(settingsSchema.parse(legacy).generalSearch).toEqual(defaultSettings.generalSearch);
    legacy.generalSearch = { ...defaultSettings.generalSearch, maxQueries: 21 };
    expect(settingsSchema.safeParse(legacy).success).toBe(false);
  });

  it('bounds timer intervals to the largest safe whole-minute Node timeout', () => {
    const boundary = structuredClone(defaultSettings);
    boundary.monitoring.intervalMinutes = 35_791;
    expect(settingsSchema.safeParse(boundary).success).toBe(true);
    boundary.monitoring.intervalMinutes = 35_792;
    expect(settingsSchema.safeParse(boundary).success).toBe(false);
  });

  it.each([
    ['integrations.prowlarr.url', (settings: typeof defaultSettings) => { settings.integrations.prowlarr.url = 'http://user:secret@prowlarr.local'; }],
    ['integrations.sonarr.url', (settings: typeof defaultSettings) => { settings.integrations.sonarr.url = 'https://user:secret@sonarr.local'; }],
    ['integrations.radarr.url', (settings: typeof defaultSettings) => { settings.integrations.radarr.url = 'http://user:secret@radarr.local'; }],
    ['ai.baseUrl', (settings: typeof defaultSettings) => { settings.ai.baseUrl = 'https://user:secret@llm.local/v1'; }],
  ])('rejects URL userinfo at %s without echoing credential text', (_path, setInvalidUrl) => {
    const invalid = structuredClone(defaultSettings);
    setInvalidUrl(invalid);
    const result = settingsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain('secret');
  });
});
