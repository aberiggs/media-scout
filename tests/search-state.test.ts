import { describe, expect, it } from 'vitest';
import { openSearchStore } from '../src/search/store';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('search store persistence and ownership', () => {
  it('persists jobs, private candidates, events, settings, deadlines and observations across reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-restart-'));
    const path = join(directory, 'state.sqlite');
    let store = openSearchStore(path);
    store.createSearch({ searchId: 's1', prompt: 'find', status: 'queued', createdAt: 100 });
    store.addCandidate({ searchId: 's1', candidateId: 'c1', safe: { title: 'Release' }, privateData: { guid: 'secret' }, expiresAt: 900 });
    store.appendEvent('s1', { type: 'query', query: 'find', count: 1 });
    store.setSetting('preferences', { resolutions: ['1080p'] });
    store.setDeadline('target-1', 500);
    store.setProviderDeadline('indexer-2', 600);
    store.saveObservation('sonarr', { observedAt: 100, complete: false, payload: { items: [] } });
    store.reserveSubmission({ idempotencyKey: 'persisted', payload: { option: 'one' }, owner: 'old', targets: ['t'], physicalReleases: ['r'], now: 100, graceMs: 300 });
    store.close();
    store = openSearchStore(path);
    expect(store.getSearch('s1')?.status).toBe('queued');
    expect(store.getCandidate('s1', 'c1', 200)?.privateData).toEqual({ guid: 'secret' });
    expect(store.getEvents('s1')).toHaveLength(1);
    expect(store.getSetting('preferences')).toEqual({ resolutions: ['1080p'] });
    expect(store.getDeadline('target-1')).toBe(500);
    expect(store.getProviderDeadline('indexer-2')).toBe(600);
    expect(store.getObservation('sonarr')).toMatchObject({ complete: false });
    expect(store.getCandidate('s1', 'c1', 901)).toBeNull();
    expect(store.getSubmission('persisted')).toMatchObject({ outcome: 'submitting' });
    expect(store.reserveSubmission({ idempotencyKey: 'new', payload: {}, owner: 'new', targets: ['t'], physicalReleases: ['other'], now: 200, graceMs: 300 })).toMatchObject({ kind: 'deferred', reason: 'target' });
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it('enforces lease ownership and rolls back failed writes', () => {
    const store = openSearchStore(':memory:');
    expect(store.acquireLease('target:t1', 'owner-a', 10, 100)).toBe(true);
    expect(store.acquireLease('target:t1', 'owner-b', 20, 100)).toBe(false);
    expect(() => store.withLease('target:t1', 'owner-b', () => { throw new Error('write failed'); })).toThrow('stale lease owner');
    expect(store.acquireLease('target:t1', 'owner-b', Date.now(), 100_000)).toBe(true);
    expect(() => store.withLease('target:t1', 'owner-a', () => store.setDeadline('stale', 1))).toThrow('stale lease owner');
    expect(store.getDeadline('stale')).toBeNull();
    expect(() => store.withLease('target:t1', 'owner-b', () => { store.createSearch({ searchId: 'rollback', prompt: 'x', status: 'running', createdAt: 1 }); throw new Error('write failed'); })).toThrow('write failed');
    expect(store.getSearch('rollback')).toBeNull();
    store.close();
  });
  it('shortens only mirrored search-only legacy deadlines and preserves submission or grace holds', () => {
    const store = openSearchStore(':memory:'), now = 10_000, retry = 30 * 60_000;
    for (const target of ['search-only', 'receipt', 'grace', 'unmirrored']) {
      const deadline = now + 6 * 60 * 60_000;
      store.setAutomationAttempt(target, { lastAttempt: now, failCount: 0, deadline, graceUntil: target === 'grace' ? deadline : 0 });
      store.setDeadline(target, target === 'unmirrored' ? deadline - 1 : deadline);
    }
    store.createSearch({ searchId: 'legacy-search', prompt: 'Find', status: 'matched', createdAt: now });
    store.setSetting('search-arr:legacy-search', { key: 'search-only' });
    store.setSetting('search-source:legacy-search', 'automation');
    store.recordSubmission({ idempotencyKey: 'grab', payload: { targets: ['receipt'] }, outcome: 'submitted', createdAt: now });
    store.migrateLegacySearchDeadlines(now, retry);
    expect(store.getAutomationAttempt('search-only')?.deadline).toBe(now + retry);
    expect(store.getDeadline('search-only')).toBe(now + retry);
    expect(store.getAutomationAttempt('receipt')?.deadline).toBe(now + 6 * 60 * 60_000);
    expect(store.getAutomationAttempt('grace')?.deadline).toBe(now + 6 * 60 * 60_000);
    expect(store.getDeadline('unmirrored')).toBe(now + 6 * 60 * 60_000 - 1);
    store.migrateLegacySearchDeadlines(now, 60 * 60_000);
    expect(store.getDeadline('search-only')).toBe(now + retry);
    store.close();
  });
  it('prunes old search history without deleting submission receipts', () => {
    const store = openSearchStore(':memory:');
    store.createSearch({ searchId: 'old', prompt: 'old', status: 'matched', createdAt: 1, finishedAt: 1 });
    store.recordSubmission({ idempotencyKey: 'k', payload: { optionId: 'o' }, outcome: 'uncertain', createdAt: 2 });
    store.pruneSearches(3, 10);
    expect(store.getSearch('old')).toBeNull();
    expect(store.getSubmission('k')?.outcome).toBe('uncertain');
    store.close();
  });
});
