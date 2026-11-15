import { describe, expect, it } from 'vitest';
import { openSearchStore } from '../src/search/store';

describe('submission receipts', () => {
  it('replays an identical idempotency key but conflicts when its payload changes', () => {
    const store = openSearchStore(':memory:');
    expect(store.beginSubmission({ idempotencyKey: 'k1', payload: { optionId: 'o1' }, createdAt: 10 })).toEqual({ kind: 'created' });
    expect(store.beginSubmission({ idempotencyKey: 'k1', payload: { optionId: 'o1' }, createdAt: 20 })).toMatchObject({ kind: 'replay', receipt: { createdAt: 10 } });
    expect(store.beginSubmission({ idempotencyKey: 'k1', payload: { optionId: 'o2' }, createdAt: 20 })).toEqual({ kind: 'conflict' });
    store.close();
  });
  it('atomically prevents overlapping target and physical-release submissions during finite grace', () => {
    const store = openSearchStore(':memory:');
    expect(store.reserveSubmission({ idempotencyKey: 'k1', payload: { x: 1 }, owner: 'a', targets: ['t1'], physicalReleases: ['r1'], now: 100, graceMs: 300 })).toEqual({ kind: 'reserved' });
    expect(store.reserveSubmission({ idempotencyKey: 'k2', payload: { x: 2 }, owner: 'b', targets: ['t1'], physicalReleases: ['r2'], now: 200, graceMs: 300 })).toMatchObject({ kind: 'deferred', reason: 'target' });
    expect(store.reserveSubmission({ idempotencyKey: 'k3', payload: { x: 3 }, owner: 'c', targets: [], physicalReleases: ['r1'], now: 200, graceMs: 300 })).toMatchObject({ kind: 'deferred', reason: 'physical-release' });
    for (const resource of ['submission:k1', 'target:t1', 'physical:r1']) store.releaseLease(resource, 'a');
    expect(store.reserveSubmission({ idempotencyKey: 'k4', payload: { x: 4 }, owner: 'd', targets: ['t1'], physicalReleases: ['r1'], now: 401, graceMs: 300 })).toEqual({ kind: 'reserved' });
    store.close();
  });
  it('does not retain a key lease after deferring for another submission grace', () => {
    const store = openSearchStore(':memory:');
    const reserve = (key: string, owner: string, now: number) => store.reserveSubmission({ idempotencyKey: key, payload: { key }, owner, targets: ['t'], physicalReleases: [], now, graceMs: 100 });
    expect(reserve('first', 'a', 100)).toEqual({ kind: 'reserved' });
    expect(reserve('later', 'b', 150)).toMatchObject({ kind: 'deferred' });
    for (const resource of ['submission:first', 'target:t']) store.releaseLease(resource, 'a');
    expect(reserve('later', 'successor', 201)).toEqual({ kind: 'reserved' });
    store.close();
  });
  it('rejects changed-payload receipt completion without mutating the original outcome', () => {
    const store = openSearchStore(':memory:');
    store.beginSubmission({ idempotencyKey: 'key', payload: { option: 'a' }, createdAt: 100 });
    expect(() => store.recordSubmission({ idempotencyKey: 'key', payload: { option: 'b' }, outcome: 'submitted', createdAt: 200 })).toThrow('payload conflict');
    expect(store.getSubmission('key')).toMatchObject({ outcome: 'submitting', payload: { option: 'a' }, createdAt: 100 });
    store.close();
  });
  it('rolls back partial reservations when a later grace insert fails', () => {
    const store = openSearchStore(':memory:');
    expect(() => store.reserveSubmission({ idempotencyKey: 'broken', payload: {}, owner: 'old', targets: ['t'], physicalReleases: ['same', 'same'], now: 100, graceMs: 300 })).toThrow();
    expect(store.getSubmission('broken')).toBeNull();
    expect(store.reserveSubmission({ idempotencyKey: 'broken', payload: {}, owner: 'new', targets: ['t'], physicalReleases: ['same'], now: 100, graceMs: 300 })).toEqual({ kind: 'reserved' });
    store.createSearch({ searchId: 'pruned', prompt: 'old', status: 'matched', createdAt: 1, finishedAt: 2 });
    expect(store.pruneSearches(200, 100)).toBe(1);
    expect(store.getSearch('pruned')).toBeNull();
    expect(store.reserveSubmission({ idempotencyKey: 'another', payload: {}, owner: 'third', targets: ['t'], physicalReleases: [], now: 150, graceMs: 300 })).toMatchObject({ kind: 'deferred' });
    store.close();
  });
  it('updates an outcome without changing the prepared payload or creation time', () => {
    const store = openSearchStore(':memory:');
    try {
      const payload = { request: { searchId: 's', optionId: 'o' }, candidateIds: ['c'] };
      expect(store.beginSubmission({ idempotencyKey: 'k', payload, createdAt: 10 })).toEqual({ kind: 'created' });
      store.updateSubmissionOutcome('k', 'submitted');
      expect(store.getSubmission('k')).toEqual({ idempotencyKey: 'k', payload, outcome: 'submitted', createdAt: 10 });
    } finally { store.close(); }
  });
});
