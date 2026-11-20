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
    store.setAutomationAttempt('target-1', { lastAttempt: 100, failCount: 0, deadline: 500, graceUntil: 0 });
    store.setProviderDeadline('indexer-2', 600);
    store.saveObservation('sonarr', { observedAt: 100, complete: false, payload: { items: [] } });
    store.close();
    store = openSearchStore(path);
    expect(store.getSearch('s1')?.status).toBe('queued');
    expect(store.getCandidate('s1', 'c1', 200)?.privateData).toEqual({ guid: 'secret' });
    expect(store.getEvents('s1')).toHaveLength(1);
    expect(store.getSetting('preferences')).toEqual({ resolutions: ['1080p'] });
    expect(store.getAutomationAttempt('target-1')?.deadline).toBe(500);
    expect(store.getProviderDeadline('indexer-2')).toBe(600);
    expect(store.getObservation('sonarr')).toMatchObject({ complete: false });
    expect(store.getCandidate('s1', 'c1', 901)).toBeNull();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it('keeps a live lease exclusive until expiration', () => {
    const store = openSearchStore(':memory:');
    expect(store.acquireLease('target:t1', 'owner-a', 10, 100)).toBe(true);
    expect(store.acquireLease('target:t1', 'owner-b', 20, 100)).toBe(false);
    expect(store.acquireLease('target:t1', 'owner-b', 110, 100)).toBe(true);
    expect(store.ownsLease('target:t1', 'owner-a', 110)).toBe(false);
    expect(store.ownsLease('target:t1', 'owner-b', 110)).toBe(true);
    store.close();
  });
});
