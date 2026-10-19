import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { Runner } from '../src/core/runner';
import { State } from '../src/core/state';
import type { LibrarySnapshot } from '../src/core/watcher';
import type { QueueReviewEvidence, WorkItem } from '../src/core/work-queue-types';

const now = '2026-10-18T12:00:00.000Z';
const before = '2026-10-18T11:00:00.000Z';
const states: State[] = [];
afterEach(() => { for (const state of states.splice(0)) state.close(); });
const evidence: QueueReviewEvidence = { version: 1, cause: 'queue-disappeared', contentIdentity: 'sonarr:4:44:tv',
  arr: 'sonarr', serviceId: 4, externalId: 44, episodeIds: [101], scope: 'targets', observedAt: before };
function setup(change: { unknown?: boolean; identity?: number; observedAt?: string; imported?: boolean; missingTarget?: boolean;
  scope?: 'targets' | 'unknown'; legacy?: boolean; linked?: boolean } = {}) {
  const state = State.open(':memory:'); states.push(state);
  const work: WorkItem = { workKey: 'sonarr:4:s1', contentIdentity: evidence.contentIdentity, missingFingerprint: 'old',
    unit: { key: 'sonarr:4:s1', kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [],
      season: { seasonNumber: 1, missing: [{ episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Aired' },
        { episodeId: 102, episodeNumber: 2, absoluteEpisodeNumber: null, title: 'Future' }] } },
    status: 'ready', blockedReason: null, lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null,
    lastObservedAt: before, lastQueueObservedAt: before, queueObservationKnown: true };
  const owner = state.claimUnit(work.workKey, new Date(before))!;
  state.applyWorkReconciliation({ key: work.workKey, token: owner, work, intentUpdates: [] });
  let intentId: string | undefined;
  if (change.linked) {
    const capture = state.beginGrab({ key: work.workKey, token: owner, fingerprint: work.missingFingerprint,
      release: { arr: 'sonarr', indexerId: 1, guid: 'synthetic-job', infoHash: null, releaseTitle: 'Show S01E01' },
      coverage: [{ workKey: work.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: before, deadline: now });
    if (!capture.ok) throw new Error(capture.reason);
    intentId = capture.intentId;
  }
  if (change.legacy) state.flagManualReview(work.workKey, 'queue-review', undefined, new Date(before));
  else state.flagQueueReview({ workKey: work.workKey, ownerToken: owner,
    evidence: change.scope === 'unknown' ? { ...evidence, scope: 'unknown', episodeIds: null } : evidence,
    intentId, now: before });
  state.applyWorkReconciliation({ key: work.workKey, token: owner, work: { ...work, status: 'manual', blockedReason: 'queue-review' }, intentUpdates: [] });
  state.applyWorkQueueObservation({ key: work.workKey, token: owner, observedAt: before, known: true, coverage: [] });
  state.releaseClaim(work.workKey, owner);
  const episode = { id: 101, seriesId: 4, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Aired',
    airDate: '2020-01-01', monitored: true, hasFile: change.imported !== false };
  const snapshot: LibrarySnapshot = { observedAt: change.observedAt ?? now, sonarr: { known: !change.unknown, series: [{
    series: { id: 4, tvdbId: change.identity ?? 44, title: 'Show', titleSlug: 'show', seriesType: 'standard', monitored: true, seasons: [], alternateTitles: [] },
    known: !change.unknown, episodes: change.unknown ? null : [...(change.missingTarget ? [] : [episode]),
      { ...episode, id: 102, episodeNumber: 2, title: 'Future', hasFile: false, airDate: '2027-01-01' }] }] }, radarr: { known: true, movies: [] } };
  const runner = new Runner({ state, watcher: { getSnapshot: async () => snapshot } as never,
    sonarr: { getQueue: async () => [] } as never, radarr: { getQueue: async () => [] } as never,
    planner: {} as never, picker: {} as never, prowlarr: {} as never, config: { dryRun: true, minRetryHours: 6 },
    clientNames: { tv: 'tv', movie: 'movie' }, logger: pino({ level: 'silent' }), now: () => new Date(now) });
  return { state, runner, snapshot };
}

describe('captured queue review lifecycle', () => {
  it('rebuilds a reset legacy item from the next known poll without searching future episodes', async () => {
    const { state, runner } = setup({ legacy: true });
    const at = '2026-10-18T11:30:00.000Z';
    const lease = state.claimUnits({ keys: ['sonarr:4:s1', 'group:sonarr:4'], now: new Date(at) })!;
    state.applyWorkAction({ workKey: 'sonarr:4:s1', action: 'reset', ownerToken: lease.ownerToken, claimKeys: lease.keys, now: at });
    state.releaseClaims({ keys: lease.keys, ownerToken: lease.ownerToken });
    expect(state.listManualReview()).toEqual([]);
    expect(state.listManualReview(true)[0]?.resolvedAt).toBe(at);
    await runner.cycle();
    expect(state.getWorkItem('sonarr:4:s1')).toMatchObject({ status: 'waiting-release' });
    expect(state.getWorkItem('sonarr:4:s1')?.resetPendingAt).toBeFalsy();
    expect(state.listSearchActivity(now)).toEqual([]);
  });

  it('reset preserves a linked review and every reservation while clearing only unlinked clutter', () => {
    const { state } = setup({ linked: true, imported: false });
    state.flagManualReview('sonarr:4:s1', 'no-suitable-release', undefined, new Date(before));
    state.recordRelease(1, 'synthetic-dedupe', 'sonarr:4:s1', new Date(before));
    const intents = state.listGrabIntents();
    const at = '2026-10-18T11:30:00.000Z';
    const lease = state.claimUnits({ keys: ['sonarr:4:s1', 'group:sonarr:4'], now: new Date(at) })!;
    state.applyWorkAction({ workKey: 'sonarr:4:s1', action: 'reset', ownerToken: lease.ownerToken, claimKeys: lease.keys, now: at });
    expect(state.listManualReview()).toMatchObject([{ reason: 'queue-review', subjectKind: 'intent', resolvedAt: null }]);
    expect(state.listGrabIntents()).toEqual(intents);
    expect(state.hasRelease(1, 'synthetic-dedupe')).toBe(true);
  });

  it('retires an imported captured episode without holding future siblings or searching them', async () => {
    const { state, runner } = setup();
    await runner.cycle();
    expect(state.listManualReview()).toEqual([]);
    expect(state.listManualReview(true)[0]?.resolvedAt).toBe(now);
    expect(state.getWorkItem('sonarr:4:s1')).toMatchObject({ status: 'waiting-release', blockedReason: 'waiting-release' });
    expect(state.listSearchActivity(now)).toEqual([]);
    await runner.cycle();
    expect(state.listManualReview(true)[0]?.resolvedAt).toBe(now);
  });

  it.each([{ unknown: true }, { identity: 99 }, { imported: false }, { missingTarget: true },
    { observedAt: '2026-10-16T00:00:00.000Z' }, { observedAt: '2026-10-19T00:00:00.000Z' },
    { scope: 'unknown' as const }, { legacy: true }])('preserves review without positive scoped fresh import proof %j', async (change) => {
    const { state, runner } = setup(change);
    await runner.cycle();
    expect(state.listManualReview().some((review) => review.createdAt === before)).toBe(true);
  });

  it('keeps a linked review until its captured intent is positively fulfilled', async () => {
    const { state, runner } = setup({ linked: true });
    await runner.cycle();
    expect(state.listGrabIntents()[0]?.status).toBe('fulfilled');
    await runner.cycle();
    expect(state.listManualReview()).toEqual([]);
    expect(state.listGrabIntents()[0]?.releasedAt).toBeUndefined();
  });
});
