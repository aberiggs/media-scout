import { describe, expect, it } from 'vitest';
import { defaultSettings, settingsSchema, missingSettings } from '../src/settings';
import { SearchRuntime } from '../src/search/runtime';
import { openSearchStore } from '../src/search/store';
describe('search-first settings', () => {
  it('defaults to disabled monitoring and no downloads', () => {
    expect(settingsSchema.parse(defaultSettings)).toMatchObject({ version: 5, safety: { dryRun: true }, monitoring: { enabled: false, allowDownloads: false, searchRetryMinutes: 30 }, search: { maxDecisions: 100, maxSearches: 100, deadlineMinutes: 30 } });
    expect(defaultSettings.ai.model).toBe('openai/gpt-6.1-sol');
  });
  it('defaults missing v5 concurrency without losing settings and validates the saved bound', () => {
    const saved = { ...defaultSettings, ai: { ...defaultSettings.ai, model: 'saved-model' }, search: { maxDecisions: 20, maxSearches: 12, deadlineMinutes: 10 } };
    expect(settingsSchema.parse(saved)).toMatchObject({ai:{model:'saved-model'},search:{...saved.search,concurrentSearches:3}});
    for (const concurrentSearches of [0, 11, 1.5]) expect(settingsSchema.safeParse({...saved,search:{...saved.search,concurrentSearches}}).success).toBe(false);
    expect(settingsSchema.parse({...saved,search:{...saved.search,concurrentSearches:10}}).search.concurrentSearches).toBe(10);
  });
  it('only accepts explicit numeric client IDs or no selection', () => {
    const settings = structuredClone(defaultSettings);
    const withId = (tvClientId: unknown) => ({ ...settings, integrations: { ...settings.integrations, prowlarr: { ...settings.integrations.prowlarr, tvClientId } } });
    expect(settingsSchema.parse(withId(12)).integrations.prowlarr).toMatchObject({ tvClientId: 12, movieClientId: null });
    expect(settingsSchema.safeParse(withId('7')).success).toBe(false);
    expect(settingsSchema.safeParse(withId(0)).success).toBe(false);
    expect(settingsSchema.safeParse({ ...settings, version: 4 }).success).toBe(false);
  });
  it('requires a new client selection when switching Prowlarr instances with the same ID', async () => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { url: 'http://old.fixture', apiKey: 'fixture', tvClientId: 7, movieClientId: 7 };
    settings.monitoring.allowDownloads = true;
    const runtime = new SearchRuntime({ store: openSearchStore(':memory:'), initialSettings: settings, clients: current => ({
      prowlarr: { getIndexers: async () => [], getIndexerStatuses: async () => [], search: async () => [],
        getDownloadClients: async () => [{ id: 7, name: current.integrations.prowlarr.url.includes('old') ? 'Old client' : 'Different client', enable: true, protocol: 'torrent', supportsCategories: false, categories: [] }] },
    }) });
    try {
      expect(await runtime.downloadClients()).toMatchObject([{ id: 7, name: 'Old client' }]);
      const switched = structuredClone(settings);
      switched.integrations.prowlarr.url = 'http://new.fixture';
      expect(runtime.saveSettings(switched)).toMatchObject({ ok: true });
      expect(runtime.getSettings()).toMatchObject({ integrations: { prowlarr: { tvClientId: null, movieClientId: null } }, monitoring: { allowDownloads: true } });
      expect(await runtime.downloadClients()).toMatchObject([{ id: 7, name: 'Different client' }]);
      expect(runtime.saveSettings(switched)).toMatchObject({ ok: true, settings: { integrations: { prowlarr: { tvClientId: 7 } } } });
    } finally { await runtime.close(); }
  });
  it('does not migrate a previously saved model when the new-install default changes', () => {
    const saved = { ...defaultSettings, ai: { ...defaultSettings.ai, model: 'z-ai/glm-5.3-flash' } };
    expect(settingsSchema.parse(saved)).toEqual(saved);
  });
  it('requires only search connections for standalone readiness', () => {
    const settings = structuredClone(defaultSettings);
    settings.integrations.prowlarr = { ...settings.integrations.prowlarr, url: 'http://indexer.test', apiKey: 'fake' };
    settings.ai.apiKey = 'fake';
    expect(missingSettings(settings)).toEqual([]);
  });
  it('rejects legacy settings, unsafe URLs and invalid budget/rate bounds', () => {
    expect(settingsSchema.safeParse({ ...defaultSettings, version: 1 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...defaultSettings, search: { ...defaultSettings.search, maxSearches: 999 } }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...defaultSettings, search: { ...defaultSettings.search, maxDecisions: 101 } }).success).toBe(false);
    expect(settingsSchema.parse({ ...defaultSettings, search: { maxDecisions: 100, maxSearches: 100, deadlineMinutes: 30 } }).search).toEqual({ maxDecisions: 100, maxSearches: 100, deadlineMinutes: 30, concurrentSearches: 3 });
    expect(settingsSchema.safeParse({ ...defaultSettings, ai: { ...defaultSettings.ai, baseUrl: 'https://user:password@example.test' } }).success).toBe(false);
  });
  it('round-trips existing lower search budgets without rewriting them', () => {
    const existing = { ...defaultSettings, search: { maxDecisions: 20, maxSearches: 12, deadlineMinutes: 10 } };
    expect(settingsSchema.parse(existing)).toEqual({...existing,search:{...existing.search,concurrentSearches:3}});
  });
  it('saves larger accepted budgets and reads them back without mutating existing saved values', async () => {
    const store = openSearchStore(':memory:');
    const runtime = new SearchRuntime({ store });
    try {
      const larger = { ...defaultSettings, search: { maxDecisions: 100, maxSearches: 100, deadlineMinutes: 30 } };
      expect(runtime.saveSettings(larger)).toMatchObject({ ok: true, settings: { search: larger.search } });
      expect(runtime.getSettings().search).toEqual({...larger.search,concurrentSearches:3});
      const old = { ...defaultSettings, search: { maxDecisions: 20, maxSearches: 12, deadlineMinutes: 10 } };
      store.setSetting('application-settings', old);
      expect(runtime.getSettings().search).toEqual({...old.search,concurrentSearches:3});
      expect(store.getSetting('application-settings')).toEqual(old);
    } finally { await runtime.close(); }
  });
});
