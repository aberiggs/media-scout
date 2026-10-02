import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { State } from '../src/core/state';
import type { AssociationCacheEntry, AssociationRequest } from '../src/core/group-types';

const NOW = '2026-01-01T00:00:00.000Z';
const entry: AssociationCacheEntry = {
  arr: 'sonarr', sourceJobKey: 'private-job-key', materialSignature: 'material-1', contextSignature: 'context-1', promptVersion: 'v1', cachedAt: NOW,
  decisions: [{ arr: 'sonarr', queueRef: 'queue:opaque', outcome: 'uncertain', mediaReferences: [], workReferences: [], potentialScope: 'unknown', seasonNumber: null, episodeIds: null, basis: null, uncertainty: 'insufficient-evidence' }],
};

function request(value: AssociationCacheEntry): AssociationRequest {
  return { arr: value.arr, sourceJobKey: value.sourceJobKey, materialSignature: value.materialSignature, contextSignature: value.contextSignature, promptVersion: value.promptVersion, queue: [], media: [], targets: [], lookup: { queueRefsByIndex: [], mediaReferencesByIndex: [], workReferencesByIndex: [], workUnitsByIndex: [] } };
}

describe('durable association cache state', () => {
  it('round-trips validated durable references and retry signatures under the source lease', () => {
    const db = new Database(':memory:');
    const state = new State(db);
    const ownerToken = state.claimUnit('association:sonarr', new Date(NOW));
    if (!ownerToken) throw new Error('source lease unavailable');
    state.putAssociationCache({ entry, leaseKey: 'association:sonarr', ownerToken, now: NOW });
    expect(state.listAssociationCache()).toEqual([entry]);
    expect(state.getAssociationRetry({ arr: 'sonarr', sourceJobKey: entry.sourceJobKey })).toEqual({ materialSignature: 'material-1', contextSignature: 'context-1', promptVersion: 'v1', nextAttemptAt: null, failCount: 0 });
    state.recordAssociationFailure({ request: request(entry), leaseKey: 'association:sonarr', ownerToken, now: NOW, nextAttemptAt: '2026-01-01T00:05:00.000Z', failCount: 2 });
    expect(state.getAssociationRetry({ arr: 'sonarr', sourceJobKey: entry.sourceJobKey })).toMatchObject({ nextAttemptAt: '2026-01-01T00:05:00.000Z', failCount: 2 });
  });

  it('rejects cache writes without the current matching source lease and rejects index-only/corrupt durable decisions', () => {
    const db = new Database(':memory:');
    const state = new State(db);
    const ownerToken = state.claimUnit('association:sonarr', new Date(NOW));
    if (!ownerToken) throw new Error('source lease unavailable');
    expect(() => state.putAssociationCache({ entry, leaseKey: 'association:radarr', ownerToken, now: NOW })).toThrow();
    expect(() => state.putAssociationCache({ entry: { ...entry, decisions: [{ ...entry.decisions[0]!, queueIndex: 0 } as never] }, leaseKey: 'association:sonarr', ownerToken, now: NOW })).toThrow();
    state.putAssociationCache({ entry, leaseKey: 'association:sonarr', ownerToken, now: NOW });
    db.pragma('ignore_check_constraints = ON');
    db.prepare('UPDATE queue_associations SET cache_json=?').run('{');
    expect(() => state.listAssociationCache()).toThrow();
  });

  it('invalidates cache applicability by signature, without clearing the prior successful row on failure', () => {
    const db = new Database(':memory:');
    const state = new State(db);
    const ownerToken = state.claimUnit('association:sonarr', new Date(NOW));
    if (!ownerToken) throw new Error('source lease unavailable');
    state.putAssociationCache({ entry, leaseKey: 'association:sonarr', ownerToken, now: NOW });
    const changed = { ...entry, materialSignature: 'material-2' };
    state.recordAssociationFailure({ request: request(changed), leaseKey: 'association:sonarr', ownerToken, now: NOW, nextAttemptAt: '2026-01-01T00:05:00.000Z', failCount: 1 });
    expect(state.listAssociationCache()).toEqual([entry]);
    expect(state.getAssociationRetry({ arr: 'sonarr', sourceJobKey: entry.sourceJobKey })).toMatchObject({ materialSignature: 'material-2', failCount: 1 });
    expect(state.listAssociationCache()[0]?.materialSignature).not.toBe(changed.materialSignature);
  });

  it('rejects association writes for a foreign or expired source lease', () => {
    const state = new State(new Database(':memory:'));
    const ownerToken = state.claimUnit('association:sonarr', new Date(NOW));
    if (!ownerToken) throw new Error('source lease unavailable');
    expect(() => state.putAssociationCache({ entry, leaseKey: 'association:sonarr', ownerToken: 'foreign', now: NOW })).toThrow();
    expect(() => state.putAssociationCache({ entry, leaseKey: 'association:sonarr', ownerToken, now: '2026-01-01T00:16:00.000Z' })).toThrow();
    expect(state.listAssociationCache()).toEqual([]);
  });
});
