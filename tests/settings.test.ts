import { describe, expect, it } from 'vitest';
import { defaultSettings, settingsSchema, missingSettings } from '../src/settings';
describe('search-first settings', () => {
  it('defaults to disabled monitoring and no downloads', () => {
    expect(settingsSchema.parse(defaultSettings)).toMatchObject({ version: 2, safety: { dryRun: true }, monitoring: { enabled: false }, search: { maxDecisions: 20, maxSearches: 12 } });
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
});
