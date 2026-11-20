import { describe, expect, it } from 'vitest';
import { defaultSettings, migrateSettings, settingsSchema, missingSettings } from '../src/settings';
import { SearchRuntime } from '../src/search/runtime';
import { openSearchStore } from '../src/search/store';
describe('search-first settings', () => {
  it('defaults to disabled monitoring and no downloads', () => {
    expect(settingsSchema.parse(defaultSettings)).toMatchObject({ version: 4, safety: { dryRun: true }, monitoring: { enabled: false, allowDownloads: false, searchRetryMinutes: 30 }, search: { maxDecisions: 100, maxSearches: 100, deadlineMinutes: 30 } });
    expect(defaultSettings.ai.model).toBe('openai/gpt-6.1-sol');
  });
  it('migrates saved v3 settings to require explicit download activation without changing dry-run', () => {
    const old = structuredClone(defaultSettings) as any;
    old.version = 3;
    delete old.monitoring.allowDownloads;
    old.monitoring.enabled = true;
    old.safety.dryRun = false;
    expect(migrateSettings(old)).toMatchObject({ migrated: true, settings: { monitoring: { enabled: true, allowDownloads: false }, safety: { dryRun: false } } });
  });
  it('does not migrate a previously saved model when the new-install default changes', () => {
    const saved = { ...defaultSettings, ai: { ...defaultSettings.ai, model: 'z-ai/glm-5.3-flash' } };
    expect(migrateSettings(saved)).toEqual({ migrated: false, settings: saved });
  });
  it('requires only search connections for standalone readiness', () => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://indexer.test', apiKey: 'fake', tvClient: '', movieClient: '' };
    settings.ai.apiKey = 'fake';
    expect(missingSettings(settings)).toEqual([]);
  });
  it('rejects legacy settings, unsafe URLs and invalid budget/rate bounds', () => {
    expect(settingsSchema.safeParse({ ...defaultSettings, version: 1 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...defaultSettings, search: { ...defaultSettings.search, maxSearches: 999 } }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...defaultSettings, search: { ...defaultSettings.search, maxDecisions: 101 } }).success).toBe(false);
    expect(settingsSchema.parse({ ...defaultSettings, search: { maxDecisions: 100, maxSearches: 100, deadlineMinutes: 30 } }).search).toEqual({ maxDecisions: 100, maxSearches: 100, deadlineMinutes: 30 });
    expect(settingsSchema.safeParse({ ...defaultSettings, ai: { ...defaultSettings.ai, baseUrl: 'https://user:password@example.test' } }).success).toBe(false);
  });
  it('round-trips existing lower search budgets without rewriting them', () => {
    const existing = { ...defaultSettings, search: { maxDecisions: 20, maxSearches: 12, deadlineMinutes: 10 } };
    expect(migrateSettings(existing)).toEqual({ migrated: false, settings: existing });
  });
  it('saves larger accepted budgets and reads them back without mutating existing saved values', async () => {
    const store = openSearchStore(':memory:');
    const runtime = new SearchRuntime({ store });
    try {
      const larger = { ...defaultSettings, search: { maxDecisions: 100, maxSearches: 100, deadlineMinutes: 30 } };
      expect(runtime.saveSettings(larger)).toMatchObject({ ok: true, settings: { search: larger.search } });
      expect(runtime.getSettings().search).toEqual(larger.search);
      const old = { ...defaultSettings, search: { maxDecisions: 20, maxSearches: 12, deadlineMinutes: 10 } };
      store.setSetting('application-settings', old);
      expect(runtime.getSettings().search).toEqual(old.search);
      expect(store.getSetting('application-settings')).toEqual(old);
    } finally { await runtime.close(); }
  });
  it('migrates the old default retry and preserves customized hour values in minutes', () => {
    const legacy = { ...defaultSettings, version: 2 as const, monitoring: { ...defaultSettings.monitoring, minRetryHours: 6 } } as any;
    const migrated = migrateSettings(legacy);
    expect(migrated).toMatchObject({ migrated: true, settings: { version: 4, monitoring: { searchRetryMinutes: 30, allowDownloads: false } } });
    expect('minRetryHours' in (migrated.settings as any).monitoring).toBe(false);

    const customized = migrateSettings({ ...legacy, monitoring: { ...legacy.monitoring, minRetryHours: 2 } });
    expect(customized).toMatchObject({ migrated: true, settings: { monitoring: { searchRetryMinutes: 120 } } });
    const maximum = migrateSettings({ ...legacy, monitoring: { ...legacy.monitoring, minRetryHours: 8760 } });
    expect(maximum.settings.monitoring.searchRetryMinutes).toBe(525_600);
  });
});
