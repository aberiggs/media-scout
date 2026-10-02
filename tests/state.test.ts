import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/core/state';

const T1 = new Date('2026-01-01T00:00:00.000Z');
const T2 = new Date('2026-01-02T00:00:00.000Z');

describe('State.seen_hashes', () => {
  it('hasHash false before record, true after', () => {
    const s = State.open(':memory:');
    expect(s.hasHash('abc')).toBe(false);
    s.recordHash('abc', 'series:s1e1', T1);
    expect(s.hasHash('abc')).toBe(true);
  });

  it('recordHash twice is idempotent — one row, original workKey (I4)', () => {
    const db = new Database(':memory:');
    const s = new State(db);
    s.recordHash('abc', 'series:s1e1', T1);
    expect(() => s.recordHash('abc', 'series:s1e2', T2)).not.toThrow();
    const row = db.prepare('SELECT work_key, seen_at FROM seen_hashes WHERE info_hash = ?').get('abc');
    expect(row).toEqual({ work_key: 'series:s1e1', seen_at: T1.toISOString() });
  });
  it('creates the parent directory for a fresh filesystem path', () => {
    const dir = join(tmpdir(), `media-agent-state-test-${process.pid}-${Date.now()}`);
    try {
      const s = State.open(join(dir, 'nested', 'state.db'));
      s.recordHash('abc', 'series:s1e1', T1);
      expect(State.open(join(dir, 'nested', 'state.db')).hasHash('abc')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('State.seen_releases', () => {
  it('persists release identities and deduplicates only the composite indexerId+guid key', () => {
    const dir = join(tmpdir(), `media-agent-release-state-${process.pid}-${Date.now()}`);
    const path = join(dir, 'state.db');
    try {
      const s = State.open(path);
      expect(s.hasRelease(5, 'same-guid')).toBe(false);
      s.recordRelease(5, 'same-guid', 'sonarr:1:s1', T1);
      s.recordRelease(7, 'same-guid', 'sonarr:1:s2', T2);

      const reopened = State.open(path);
      expect(reopened.hasRelease(5, 'same-guid')).toBe(true);
      expect(reopened.hasRelease(7, 'same-guid')).toBe(true);
      expect(reopened.hasRelease(5, 'other-guid')).toBe(false);
      const db = new Database(path);
      expect(db.prepare('SELECT indexer_id, guid, work_key, seen_at FROM seen_releases ORDER BY indexer_id').all()).toEqual([
        { indexer_id: 5, guid: 'same-guid', work_key: 'sonarr:1:s1', seen_at: T1.toISOString() },
        { indexer_id: 7, guid: 'same-guid', work_key: 'sonarr:1:s2', seen_at: T2.toISOString() },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recording the same source-qualified identity again preserves its original metadata', () => {
    const db = new Database(':memory:');
    const s = new State(db);
    s.recordRelease(5, 'guid', 'first-work', T1);
    s.recordRelease(5, 'guid', 'second-work', T2);
    expect(db.prepare('SELECT indexer_id, guid, work_key, seen_at FROM seen_releases').all()).toEqual([
      { indexer_id: 5, guid: 'guid', work_key: 'first-work', seen_at: T1.toISOString() },
    ]);
  });
});

describe('State.decisions', () => {
  it('lastDecisionAt returns the later ISO for the same key', () => {
    const s = State.open(':memory:');
    s.recordDecision({ workKey: 'series:s1e1', verdict: 'grab', grabbed: true }, T1);
    s.recordDecision({ workKey: 'series:s1e1', releaseTitle: 'SubsPlease', infoHash: 'abc', verdict: 'skip', grabbed: false }, T2);
    expect(s.lastDecisionAt('series:s1e1')).toBe(T2.toISOString());
  });

  it('lastDecisionAt returns max decided_at, not last insert (clock rollback)', () => {
    const s = State.open(':memory:');
    s.recordDecision({ workKey: 'series:s1e1', verdict: 'grab', grabbed: true }, T2);
    s.recordDecision({ workKey: 'series:s1e1', verdict: 'skip', grabbed: false }, T1);
    expect(s.lastDecisionAt('series:s1e1')).toBe(T2.toISOString());
  });

  it('lastDecisionAt returns null for an unknown key', () => {
    const s = State.open(':memory:');
    s.recordDecision({ workKey: 'series:s1e1', verdict: 'manual', grabbed: false }, T1);
    expect(s.lastDecisionAt('series:s1e2')).toBeNull();
  });
});

describe('State.unit_claims', () => {
  it('claims once with an owner token; a conflicting fresh claim is denied (null); release frees it', () => {
    const s = State.open(':memory:');
    const soon = new Date(T1.getTime() + 60_000); // inside the claim TTL
    const token = s.claimUnit('sonarr:1:s1', T1);
    expect(typeof token).toBe('string'); // owner token, not a boolean
    expect(s.claimUnit('sonarr:1:s1', soon)).toBeNull(); // held by another process
    expect(typeof s.claimUnit('radarr:3', soon)).toBe('string'); // other units unaffected
    s.releaseClaim('sonarr:1:s1', token as string);
    expect(typeof s.claimUnit('sonarr:1:s1', soon)).toBe('string');
  });

  it('a stale owner token cannot delete a successor claim (TTL reap + replace)', () => {
    const s = State.open(':memory:');
    const staleToken = s.claimUnit('sonarr:1:s1', T1);
    const afterTtl = new Date(T1.getTime() + 16 * 60_000);
    const successorToken = s.claimUnit('sonarr:1:s1', afterTtl); // reaps the stale claim, re-claims
    expect(typeof successorToken).toBe('string');
    // The original worker finally finishes and releases — it must NOT free the successor's claim.
    s.releaseClaim('sonarr:1:s1', staleToken as string);
    expect(s.claimUnit('sonarr:1:s1', afterTtl)).toBeNull();
    s.releaseClaim('sonarr:1:s1', successorToken as string);
    expect(typeof s.claimUnit('sonarr:1:s1', afterTtl)).toBe('string');
  });

  it('reaps claims older than the 15-minute TTL (crash protection)', () => {
    const s = State.open(':memory:');
    s.claimUnit('sonarr:1:s1', T1);
    const afterTtl = new Date(T1.getTime() + 16 * 60_000);
    expect(typeof s.claimUnit('sonarr:1:s1', afterTtl)).toBe('string'); // stale claim reaped, re-claimed
    const insideTtl = new Date(T1.getTime() + 14 * 60_000);
    expect(s.claimUnit('sonarr:1:s1', insideTtl)).toBeNull(); // fresh claim still holds
  });
});

describe('State.manual_review', () => {
  it('flags, lists unresolved, resolves with timestamp', () => {
    const s = State.open(':memory:');
    s.flagManualReview('series:s1e1', 'low-confidence', 'score 0.42', T1);
    expect(s.listManualReview()).toEqual([
      { id: 1, workKey: 'series:s1e1', reason: 'low-confidence', details: 'score 0.42', createdAt: T1.toISOString(), resolvedAt: null },
    ]);
    expect(s.resolveManualReview(1, T2)).toBe(true);
    expect(s.resolveManualReview(1, T2)).toBe(false); // already resolved: no change, no false success
    expect(s.resolveManualReview(999, T2)).toBe(false); // unknown id: never report success
    expect(s.listManualReview()).toEqual([]);
    expect(s.listManualReview(true)).toEqual([
      { id: 1, workKey: 'series:s1e1', reason: 'low-confidence', details: 'score 0.42', createdAt: T1.toISOString(), resolvedAt: T2.toISOString() },
    ]);
  });

  it('lists newest first by createdAt', () => {
    const s = State.open(':memory:');
    s.flagManualReview('series:s1e1', 'old', undefined, T1);
    s.flagManualReview('series:s1e2', 'new', 'd', T2);
    const rows = s.listManualReview(true);
    expect(rows.map((r) => r.reason)).toEqual(['new', 'old']);
  });
});

describe('State additive queue-column migration', () => {
  it('upgrades the pre-failure-reference work_items schema once and preserves its durable rows across reopen', () => {
    const db = new Database(':memory:');
    const unit = {
      key: 'sonarr:4:s1', kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [],
      season: { seasonNumber: 1, missing: [{ episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot' }] },
    };
    const coverage = [{ workKey: 'sonarr:4:s1', episodeIds: [101], basis: 'explicit-episodes' }];
    db.exec(`CREATE TABLE work_items (
      work_key TEXT PRIMARY KEY, content_identity TEXT NOT NULL, missing_fingerprint TEXT NOT NULL, unit_json TEXT NOT NULL,
      status TEXT NOT NULL, last_search_at TEXT, next_search_at TEXT, fail_count REAL NOT NULL, last_outcome TEXT,
      last_observed_at TEXT NOT NULL, blocked_reason TEXT, queue_coverage_json TEXT NOT NULL DEFAULT '[]',
      queue_observed_at TEXT, queue_known INTEGER NOT NULL DEFAULT 0
    )`);
    db.prepare(`INSERT INTO work_items (work_key,content_identity,missing_fingerprint,unit_json,status,last_search_at,next_search_at,fail_count,last_outcome,last_observed_at,blocked_reason,queue_coverage_json,queue_observed_at,queue_known)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('sonarr:4:s1', 'sonarr:4:44:tv', 'fp', JSON.stringify(unit), 'cooldown', T1.toISOString(), '2026-01-02T00:00:00.000Z', 2, 'legacy-outcome', T1.toISOString(), null, JSON.stringify(coverage), T1.toISOString(), 1);

    const migrated = new State(db);
    expect(migrated.getWorkItem('sonarr:4:s1')).toMatchObject({ status: 'cooldown', failCount: 2, lastOutcome: 'legacy-outcome' });
    expect(migrated.listWorkQueueObservations()[0]).toMatchObject({ workKey: 'sonarr:4:s1', coverage, observedAt: T1.toISOString(), known: true, failedQueueRefs: [] });
    const reopened = new State(db);
    expect(reopened.getWorkItem('sonarr:4:s1')).toMatchObject({ status: 'cooldown', failCount: 2 });
    const migratedColumns = db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>;
    expect(migratedColumns.filter((column) => column.name === 'queue_failure_refs_json')).toHaveLength(1);
    db.close();
  });
});
