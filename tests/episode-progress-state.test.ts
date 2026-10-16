import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { State } from '../src/core/state';
import type { WorkItem } from '../src/core/work-queue-types';
import type { Episode } from '../src/types/sonarr';

const now = '2026-01-01T00:00:00.000Z';
const work: WorkItem = { workKey: 'sonarr:4:s1', contentIdentity: 'sonarr:4:s1', missingFingerprint: '1', unit: { key:'sonarr:4:s1',kind:'tv',arr:'sonarr',serviceId:4,externalId:44,title:'Show',altTitles:[],season:{seasonNumber:1,missing:[{episodeId:1,episodeNumber:1,absoluteEpisodeNumber:null,title:'Pilot'}]} }, status:'ready',lastSearchAt:null,nextSearchAt:null,failCount:0,lastOutcome:null,lastObservedAt:now,lastQueueObservedAt:null,queueObservationKnown:false,blockedReason:null };
const episode: Episode = { id:1,seriesId:4,seasonNumber:1,episodeNumber:1,absoluteEpisodeNumber:null,title:'Pilot',airDate:'2025-12-31',airDateUtc:'2025-12-31T20:00:00Z',finaleType:null,monitored:true,hasFile:false };
const opened: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const db = new Database(':memory:');
  opened.push(db);
  const state = new State(db);
  const token = state.claimUnit(work.workKey, new Date(now))!;
  const observe = (episodes: Episode[] = [episode], item: WorkItem = work) => state.applyWorkReconciliation({ key: work.workKey, token, work: item, intentUpdates: [], episodeObservations: episodes });
  observe();
  const attempt = (episodeIds = [1], overrides = {}) => state.recordEpisodeAttempt({ key: work.workKey, token, episodeIds, now, nextSearchAt: '2026-01-02T00:00:00.000Z', outcome: 'release-unavailable', ...overrides });
  return { db, state, token, observe, attempt };
}

describe('episode progress state', () => {
  it('persists full season observations and per-episode attempt clocks across reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'episode-progress-'));
    directories.push(directory);
    const path = join(directory, 'state.db');
    let db = new Database(path);
    opened.push(db);
    let state = new State(db);
    const token = state.claimUnit(work.workKey, new Date(now))!;
    state.applyWorkReconciliation({key:work.workKey,token,work,intentUpdates:[],episodeObservations:[episode]});
    state.recordEpisodeAttempt({key:work.workKey,token,episodeIds:[1],now,nextSearchAt:'2026-01-02T00:00:00.000Z',outcome:'release-unavailable'});
    db.close();
    db = new Database(path);
    opened.push(db);
    state = new State(db);
    expect(state.listEpisodeProgress(work.workKey)).toMatchObject([{workKey:work.workKey,serviceId:4,externalId:44,episodeId:1,lastSearchAt:now,nextSearchAt:'2026-01-02T00:00:00.000Z',lastOutcome:'release-unavailable'}]);
    db.close();
  });

  it('opens an old schema repeatedly without altering reviews, decisions, or dedupe history', () => {
    const { db, state, token } = setup();
    state.recordRelease(5, 'synthetic-source', work.workKey, new Date(now));
    state.recordDecision({ workKey: work.workKey, verdict: 'skip', grabbed: false }, new Date(now));
    expect(state.beginGrab({ key: work.workKey, token, fingerprint: work.missingFingerprint,
      release: { arr: 'sonarr', indexerId: 5, guid: 'synthetic-pending', infoHash: null, releaseTitle: 'Show.S01E01' },
      coverage: [{ workKey: work.workKey, episodeIds: [1], basis: 'explicit-episodes' }], now,
      deadline: '2026-01-01T00:30:00.000Z' })).toMatchObject({ ok: true });
    state.flagManualReview(work.workKey, 'queue-review', undefined, new Date(now));
    const history = () => ['manual_review', 'decisions', 'seen_releases', 'grab_intents', 'queue_associations', 'operator_audit'].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const before = history();
    db.exec('DROP TABLE episode_progress');
    expect(new State(db).listEpisodeProgress()).toEqual([]);
    expect(new State(db).listEpisodeProgress()).toEqual([]);
    expect(history()).toEqual(before);
  });

  it('rejects foreign and expired owners without changing episode clocks', () => {
    const { state, attempt } = setup();
    const before = state.listEpisodeProgress();
    expect(() => attempt([1], { token: 'foreign-owner' })).toThrow();
    expect(() => attempt([1], { now: '2026-01-03T00:00:00.000Z', nextSearchAt: '2026-01-04T00:00:00.000Z' })).toThrow();
    expect(state.listEpisodeProgress()).toEqual(before);
  });

  it('rolls back the aggregate and observations if an intent update is invalid', () => {
    const { state, token } = setup();
    const before = state.getWorkItem(work.workKey);
    expect(() => state.applyWorkReconciliation({ key: work.workKey, token, work: { ...work, lastObservedAt: '2026-01-01T00:01:00.000Z', status: 'cooldown' }, episodeObservations: [{ ...episode, hasFile: true }], intentUpdates: [{ id: 'missing-intent', status: 'fulfilled' }] })).toThrow();
    expect(state.getWorkItem(work.workKey)).toEqual(before);
    expect(state.listEpisodeProgress()[0]!.hasFile).toBe(false);
  });

  it('does not roll back either aggregate or episode facts with an older observation', () => {
    const { state, observe } = setup();
    observe([{ ...episode, hasFile: true }], { ...work, lastObservedAt: '2026-01-01T00:01:00.000Z', status: 'fulfilled' });
    observe();
    expect(state.getWorkItem(work.workKey)!.status).toBe('fulfilled');
    expect(state.listEpisodeProgress()[0]!.hasFile).toBe(true);
  });

  it('keeps incomplete inventory unknown rather than authorizing historical missing rows', () => {
    const { state, observe, attempt } = setup();
    observe([], { ...work, lastObservedAt: '2026-01-01T00:01:00.000Z', status: 'inactive' });
    expect(state.listEpisodeProgress()[0]!.hasFile).toBe(false);
    expect(() => attempt([1], { now: '2026-01-01T00:02:00.000Z' })).toThrow();
  });

  it('rejects attempts against a prior content identity', () => {
    const { state, observe, attempt } = setup();
    observe([{ ...episode, id: 2 }], { ...work, unit: { ...work.unit, externalId: 55 }, contentIdentity: 'changed', lastObservedAt: '2026-01-01T00:01:00.000Z' });
    expect(() => attempt([1], { now: '2026-01-01T00:02:00.000Z' })).toThrow();
    expect(state.listEpisodeProgress().find((row) => row.episodeId === 1)!.lastSearchAt).toBeNull();
  });

  it.each([
    { hasFile: true }, { monitored: false }, { airDateUtc: '2026-02-01T00:00:00Z' },
  ])('does not record attempts for ineligible targets %j', (change) => {
    const { state, observe, attempt } = setup();
    observe([{ ...episode, ...change }], { ...work, lastObservedAt: '2026-01-01T00:01:00.000Z' });
    expect(() => attempt([1], { now: '2026-01-01T00:02:00.000Z' })).toThrow();
    expect(state.listEpisodeProgress()[0]!.lastSearchAt).toBeNull();
  });

  it('rejects an invalid batch atomically and preserves clocks across fresh observations', () => {
    const { state, observe, attempt } = setup();
    expect(() => attempt([1, 999])).toThrow();
    expect(() => attempt([1, 1])).toThrow();
    expect(state.listEpisodeProgress()[0]!.lastSearchAt).toBeNull();
    attempt();
    observe([episode], { ...work, lastObservedAt: '2026-01-01T00:01:00.000Z' });
    expect(state.listEpisodeProgress()[0]!.nextSearchAt).toBe('2026-01-02T00:00:00.000Z');
  });
});
