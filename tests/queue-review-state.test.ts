import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { State } from '../src/core/state';
import type { WorkItem } from '../src/core/work-queue-types';

const NOW = '2026-01-01T00:00:00.000Z';
const evidence = { version: 1 as const, cause: 'queue-disappeared' as const, contentIdentity: 'sonarr:4:44:tv', arr: 'sonarr' as const,
  serviceId: 4, externalId: 44, episodeIds: [101], scope: 'targets' as const, observedAt: NOW };

function work(): WorkItem {
  return { workKey: 'sonarr:4:s1', contentIdentity: evidence.contentIdentity, missingFingerprint: 'missing', unit: { key: 'sonarr:4:s1', kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44,
    title: 'Show', altTitles: [], season: { seasonNumber: 1, missing: [{ episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Pilot' }] } },
    status: 'manual', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null, lastObservedAt: NOW, lastQueueObservedAt: NOW, queueObservationKnown: true, blockedReason: 'queue-review' };
}

describe('queue review evidence', () => {
  it('adds nullable evidence storage without inventing evidence for legacy reviews and tolerates corrupt rows', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE manual_review(id INTEGER PRIMARY KEY AUTOINCREMENT,work_key TEXT NOT NULL,reason TEXT NOT NULL,details TEXT,created_at TEXT NOT NULL,resolved_at TEXT);
      INSERT INTO manual_review(work_key,reason,created_at) VALUES('sonarr:4:s1','queue-review','${NOW}');`);
    let state = new State(db);
    expect(db.prepare('PRAGMA table_info(manual_review)').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'queue_evidence_json' })]));
    expect(state.listManualReview()[0]).not.toHaveProperty('queueEvidence');
    db.prepare('UPDATE manual_review SET queue_evidence_json=? WHERE id=1').run('{');
    state = new State(db);
    expect(state.listManualReview()[0]).toMatchObject({ queueEvidenceInvalid: true });
    db.close();
  });

  it('persists versioned causes once per unresolved scope under its live work claim', () => {
    const db = new Database(':memory:');
    const state = new State(db);
    const item = work();
    const ownerToken = state.claimUnit(item.workKey, new Date(NOW))!;
    state.applyWorkReconciliation({ key: item.workKey, token: ownerToken, work: item, intentUpdates: [] });
    expect(state.flagQueueReview({ workKey: item.workKey, ownerToken, evidence, now: NOW })).toBe(true);
    expect(state.flagQueueReview({ workKey: item.workKey, ownerToken, evidence: { ...evidence, observedAt: '2026-01-01T00:01:00.000Z' }, now: '2026-01-01T00:01:00.000Z' })).toBe(false);
    expect(state.listManualReview()).toHaveLength(1);
    expect(state.listManualReview()[0]).toMatchObject({ queueEvidence: evidence });
    expect(() => state.flagQueueReview({ workKey: item.workKey, ownerToken: 'not-owner', evidence, now: NOW })).toThrow();
    const id = state.listManualReview()[0]!.id;
    state.resolveManualReview(id, new Date(NOW));
    expect(state.flagQueueReview({ workKey: item.workKey, ownerToken, evidence, now: NOW })).toBe(true);
    expect(state.listManualReview(true)).toHaveLength(2);
    expect(new State(db).listManualReview()[0]?.queueEvidence).toEqual(evidence);
    expect(() => state.flagQueueReview({ workKey: item.workKey, ownerToken, evidence: { ...evidence, externalId: 99 }, now: NOW })).toThrow();
    expect(() => state.flagQueueReview({ workKey: item.workKey, ownerToken, evidence: { ...evidence, observedAt: '2027-01-01T00:00:00.000Z' }, now: NOW })).toThrow();
    expect(() => state.resolveQueueReview({ id: state.listManualReview()[0]!.id, workKey: item.workKey, token: 'foreign', now: NOW, contentIdentity: item.contentIdentity })).toThrow();
    const persisted = db.serialize();
    db.close();
    const reopened = new Database(persisted);
    expect(new State(reopened).listManualReview()[0]?.queueEvidence).toEqual(evidence);
    reopened.close();
  });
});
