import { describe, expect, it } from 'vitest';
import { defaultSettings, migrateSettings, settingsSchema, missingSettings } from '../src/settings';
describe('search-first settings', () => {
  it('defaults to disabled monitoring and no downloads', () => {
    expect(settingsSchema.parse(defaultSettings)).toMatchObject({ version: 3, safety: { dryRun: true }, monitoring: { enabled: false, searchRetryMinutes: 30 }, search: { maxDecisions: 20, maxSearches: 12 } });
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
    expect(settingsSchema.safeParse({ ...defaultSettings, ai: { ...defaultSettings.ai, baseUrl: 'https://user:password@example.test' } }).success).toBe(false);
  });
  it('migrates the old default retry and preserves customized hour values in minutes', () => {
    const legacy = { ...defaultSettings, version: 2 as const, monitoring: { ...defaultSettings.monitoring, minRetryHours: 6 } } as any;
    const migrated = migrateSettings(legacy);
    expect(migrated).toMatchObject({ migrated: true, settings: { version: 3, monitoring: { searchRetryMinutes: 30 } } });
    expect('minRetryHours' in (migrated.settings as any).monitoring).toBe(false);

    const customized = migrateSettings({ ...legacy, monitoring: { ...legacy.monitoring, minRetryHours: 2 } });
    expect(customized).toMatchObject({ migrated: true, settings: { monitoring: { searchRetryMinutes: 120 } } });
    const maximum = migrateSettings({ ...legacy, monitoring: { ...legacy.monitoring, minRetryHours: 8760 } });
    expect(maximum.settings.monitoring.searchRetryMinutes).toBe(525_600);
  });
});
