import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildApp } from '../src/daemon';
import type { Stack } from '../src/compose';
import { SearchRuntime } from '../src/search/runtime';
import { openSearchStore } from '../src/search/store';
import { defaultSettings } from '../src/search/settings';
import type { LLMClient } from '../src/clients/llm';
import { releaseSchema } from '../src/types/prowlarr';
import { existsSync } from 'node:fs';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture() {
  let reads = 0, grabs = 0;
  const runtime = new SearchRuntime({ store: openSearchStore(':memory:'), initialSettings: { ...defaultSettings, ai: { ...defaultSettings.ai, apiKey: 'private-model' }, integrations: { ...defaultSettings.integrations, prowlarr: { ...defaultSettings.integrations.prowlarr, url: 'http://indexer.test', apiKey: 'private-indexer' } } }, llm: { json: async () => ({ action: 'finish', query: null, categories: null, indexerIds: null, status: 'no-match', options: null, message: 'Nothing suitable' }) } as LLMClient, clients: () => ({ prowlarr: { getIndexers: async () => { reads++; return [{ id: 1, name: 'Index', enable: true }]; }, getIndexerStatuses: async () => [], search: async () => [], getDownloadClients: async () => [{ id: 7, name: 'TV', protocol: 'torrent', enable: true, supportsCategories: true, categories: [] }], grab: async () => { grabs++; } } }) });
  const stack = { runtime, config: { HTTP_HOST: '127.0.0.1', HTTP_PORT: 7877, DB_PATH: ':memory:', LOG_LEVEL: 'silent' }, logger: pino({ level: 'silent' }) } as unknown as Stack;
  const app = await buildApp(stack, { webRoot: '/nonexistent-ui' });
  cleanups.push(async () => { await app.close(); await runtime.close(); });
  return { app, runtime, reads: () => reads, grabs: () => grabs };
}

describe('search-first HTTP contract', () => {
  it('contains no retired engine modules or operator CLI compatibility stub', () => {
    for (const path of ['core/runner.ts', 'core/state.ts', 'core/work-queue.ts', 'core/operations.ts', 'core/operator-actions.ts', 'operator-cli.ts']) {
      expect(existsSync(new URL(`../src/${path}`, import.meta.url)), path).toBe(false);
    }
  });
  it('reports expired options explicitly and filters recorded dry-run confirmation outcomes', async () => {
    const { app, runtime, grabs } = await fixture(), now = Date.now();
    runtime.store.createSearch({ searchId: 'match', prompt: '{"prompt":"Example"}', status: 'matched', createdAt: now, finishedAt: now, result: { options: [{ optionId: 'option', rank: 1, releases: [{ candidateId: 'candidate' }], coveredTargetIds: [], reason: 'Fit', uncertainty: '' }] } });
    runtime.store.addCandidate({ searchId: 'match', candidateId: 'candidate', safe: {}, privateData: { release: releaseSchema.parse({ guid: 'private', indexerId: 1, indexer: 'Index', title: 'Example', publishDate: '', protocol: 'torrent' }), physicalKey: 'private-key' }, expiresAt: now - 1 });
    const confirm = (key: string) => app.inject({ method: 'POST', url: '/api/v2/submissions', payload: { searchId: 'match', optionId: 'option', downloadClientId: 7, idempotencyKey: key } });
    expect((await confirm('expired')).json()).toMatchObject({ outcome: 'expired' });
    runtime.store.expireCandidatesAt('match', now + 60_000);
    expect((await confirm('preview')).json()).toMatchObject({ outcome: 'dry-run' });
    expect((await app.inject('/api/v2/activity?status=dry-run')).json()).toMatchObject({ total: 1, items: [{ submission: { outcome: 'dry-run', outcomes: [{ outcome: 'dry-run' }] } }] });
    expect(grabs()).toBe(0);
    const settings = runtime.getSettings();
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { ...settings, monitoring: { ...settings.monitoring, searchRetryMinutes: 1e15 } } })).statusCode).toBe(400);
  });
  it('starts a standalone search and exposes its persisted flat result', async () => {
    const { app, runtime } = await fixture();
    const start = await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: 'Find a film' } });
    expect(start.statusCode).toBe(202);
    const { searchId } = start.json();
    await runtime.drain();
    const status = await app.inject(`/api/v2/searches/${searchId}`);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ searchId, status: 'no-match', prompt: 'Find a film', options: [] });
    expect(status.body).not.toContain('private-model');
  });
  it('never contacts providers when reading Activity or Automation', async () => {
    const { app, reads } = await fixture();
    expect((await app.inject('/api/v2/activity')).statusCode).toBe(200);
    expect((await app.inject('/api/v2/automation')).json()).toMatchObject({ enabled: false, dryRun: true, items: [] });
    expect(reads()).toBe(0);
  });
  it('validates bounded Activity media/time filters and rejects reversed ranges', async () => {
    const { app, runtime } = await fixture(), now = Date.now();
    runtime.store.createSearch({ searchId: 'tv', prompt: '{"prompt":"Example","context":{"kind":"tv"}}', status: 'no-match', createdAt: now });
    expect((await app.inject(`/api/v2/activity?kind=tv&createdAtFrom=${encodeURIComponent(new Date(now).toISOString())}&createdAtTo=${encodeURIComponent(new Date(now).toISOString())}`)).json()).toMatchObject({ total: 1, items: [{ kind: 'tv' }] });
    expect((await app.inject('/api/v2/activity?kind=bogus')).statusCode).toBe(400);
    expect((await app.inject('/api/v2/activity?createdAtFrom=not-a-date')).statusCode).toBe(400);
    expect((await app.inject('/api/v2/activity?createdAtFrom=2026-02-01T00%3A00%3A00Z&createdAtTo=2026-01-01T00%3A00%3A00Z')).statusCode).toBe(400);
  });
  it('requires valid input and rejects cross-origin mutations without network work', async () => {
    const { app, reads } = await fixture();
    expect((await app.inject({ method: 'POST', url: '/api/v2/searches', payload: { prompt: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v2/searches', headers: { origin: 'http://evil.test' }, payload: { prompt: 'Find' } })).statusCode).toBe(403);
    expect((await app.inject('/api/v2/activity?limit=999')).statusCode).toBe(400);
    expect((await app.inject('/api/v2/searches/unknown')).statusCode).toBe(404);
    expect(reads()).toBe(0);
  });
  it('uses v2 settings with optional Arr and omits all legacy mutation routes', async () => {
    const { app, grabs } = await fixture();
    expect((await app.inject('/api/settings')).json()).toMatchObject({ settings: { version: 3 }, status: { ready: true } });
    expect((await app.inject({ method: 'POST', url: '/cycle' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/operations/work/action', payload: { action: 'reset' } })).statusCode).toBe(404);
    expect(grabs()).toBe(0);
  });
});
