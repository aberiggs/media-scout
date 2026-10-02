import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/core/state';
import type { WorkItem } from '../src/core/work-queue-types';

const NOW = '2026-01-01T00:00:00.000Z';
const DEADLINE = '2026-01-01T00:05:00.000Z';

function movieWork(key: string, serviceId: number): WorkItem {
  return {
    workKey: key,
    contentIdentity: `radarr:${serviceId}:${serviceId}:movie`,
    missingFingerprint: `missing-${serviceId}`,
    unit: { key, kind: 'movie', arr: 'radarr', serviceId, externalId: serviceId, title: `Movie ${serviceId}`, altTitles: [] },
    status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null,
    lastObservedAt: NOW, lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null,
  };
}

function prepareWork(state: State, work: WorkItem): string {
  const token = state.claimUnit(work.workKey, new Date(NOW));
  if (!token) throw new Error(`Unable to claim ${work.workKey}`);
  state.applyWorkReconciliation({ key: work.workKey, token, work, intentUpdates: [] });
  return token;
}

function reserve(state: State, work: WorkItem, token: string, input: { indexerId: number; guid: string; infoHash: string }) {
  return state.beginGrab({
    key: work.workKey,
    token,
    fingerprint: work.missingFingerprint,
    release: { arr: 'radarr', ...input, releaseTitle: work.unit.title },
    coverage: [{ workKey: work.workKey, episodeIds: null, basis: null }],
    now: NOW,
    deadline: DEADLINE,
  });
}

describe('case-insensitive durable infoHash identity', () => {
  it('deduplicates a successfully confirmed hash across casing, indexers, work units, and state reopen', () => {
    const dir = join(tmpdir(), `media-agent-hash-success-${process.pid}-${Date.now()}`);
    const path = join(dir, 'state.db');
    try {
      let state = State.open(path);
      const firstWork = movieWork('radarr:1', 1);
      const firstToken = prepareWork(state, firstWork);
      const first = reserve(state, firstWork, firstToken, { indexerId: 3, guid: 'source-one', infoHash: 'AbCdEf0123456789' });
      if (!first.ok) throw new Error(`Expected initial reservation, got ${first.reason}`);
      state.confirmGrab({ intentId: first.intentId, ownerToken: firstToken, now: NOW });

      state = State.open(path);
      const secondWork = movieWork('radarr:2', 2);
      const secondToken = prepareWork(state, secondWork);
      expect(reserve(state, secondWork, secondToken, { indexerId: 99, guid: 'different-source', infoHash: 'aBcDeF0123456789' }))
        .toEqual({ ok: false, reason: 'already-recorded' });
      expect(state.hasHash('ABCDEF0123456789')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reserves an open hash across restart despite casing and disjoint source/content identities', () => {
    const dir = join(tmpdir(), `media-agent-hash-reservation-${process.pid}-${Date.now()}`);
    const path = join(dir, 'state.db');
    try {
      let state = State.open(path);
      const firstWork = movieWork('radarr:10', 10);
      const firstToken = prepareWork(state, firstWork);
      const first = reserve(state, firstWork, firstToken, { indexerId: 4, guid: 'one', infoHash: 'DeAdBEEF01234567' });
      if (!first.ok) throw new Error(`Expected initial reservation, got ${first.reason}`);

      state = State.open(path);
      const secondWork = movieWork('radarr:11', 11);
      const secondToken = prepareWork(state, secondWork);
      expect(reserve(state, secondWork, secondToken, { indexerId: 8, guid: 'two', infoHash: 'deadbeef01234567' }))
        .toEqual({ ok: false, reason: 'hash-reserved' });
      expect(state.listGrabIntents()[0]?.infoHash).toBe('DeAdBEEF01234567');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves an uppercase-only legacy marker and stores new marker identities lowercase', () => {
    const db = new Database(':memory:');
    const state = new State(db);
    db.prepare('INSERT INTO seen_hashes(info_hash,work_key,seen_at) VALUES (?,?,?)').run('ABCDEF0123456789', 'legacy-upper-only', NOW);

    state.recordHash('abcdef0123456789', 'new-work-for-legacy-hash', new Date(DEADLINE));
    expect(db.prepare('SELECT info_hash,work_key,seen_at FROM seen_hashes').all()).toEqual([
      { info_hash: 'ABCDEF0123456789', work_key: 'legacy-upper-only', seen_at: NOW },
    ]);

    state.recordHash('FeEd0123456789Ab', 'fresh-work', new Date(DEADLINE));
    expect(db.prepare('SELECT info_hash,work_key,seen_at FROM seen_hashes WHERE work_key = ?').get('fresh-work')).toEqual({
      info_hash: 'feed0123456789ab', work_key: 'fresh-work', seen_at: DEADLINE,
    });
  });

  it('recognizes legacy mixed-case rows and preserves every colliding record without adding a duplicate', () => {
    const dir = join(tmpdir(), `media-agent-hash-legacy-${process.pid}-${Date.now()}`);
    const path = join(dir, 'state.db');
    try {
      mkdirSync(dir, { recursive: true });
      const db = new Database(path);
      new State(db);
      db.prepare('INSERT INTO seen_hashes(info_hash,work_key,seen_at) VALUES (?,?,?)').run('ABCDEF0123456789', 'legacy-upper', NOW);
      db.prepare('INSERT INTO seen_hashes(info_hash,work_key,seen_at) VALUES (?,?,?)').run('abcdef0123456789', 'legacy-lower', DEADLINE);
      db.close();

      const state = State.open(path);
      expect(state.hasHash('AbCdEf0123456789')).toBe(true);
      state.recordHash('aBcDeF0123456789', 'new-work', new Date(DEADLINE));

      const persisted = new Database(path);
      expect(persisted.prepare('SELECT info_hash,work_key,seen_at FROM seen_hashes ORDER BY work_key').all()).toEqual([
        { info_hash: 'abcdef0123456789', work_key: 'legacy-lower', seen_at: DEADLINE },
        { info_hash: 'ABCDEF0123456789', work_key: 'legacy-upper', seen_at: NOW },
      ]);
      persisted.close();
      expect(State.open(path).hasHash('ABCDEF0123456789')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
