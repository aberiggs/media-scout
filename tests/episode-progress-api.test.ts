import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { buildApp } from '../src/daemon';
import type { Stack } from '../src/compose';
import { State } from '../src/core/state';
import type { WorkItem } from '../src/core/work-queue-types';
import { defaultSettings } from '../src/settings';
import type { Episode } from '../src/types/sonarr';
import type { IntentCoverage } from '../src/core/work-queue-types';

const resources: Array<{ app: Awaited<ReturnType<typeof buildApp>>; state: State }> = [];
async function setup(age = 0) {
  const state = State.open(':memory:');
  state.saveSettings({ ...defaultSettings, integrations: { prowlarr: { url: 'http://p.test', apiKey: 'p', tvClient: 'tv', movieClient: 'movie' }, sonarr: { url: 'http://s.test', apiKey: 's' }, radarr: { url: 'http://r.test', apiKey: 'r' } }, ai: { ...defaultSettings.ai, apiKey: 'llm' } });
  const at = new Date(Date.now() - age).toISOString();
  const item: WorkItem = { workKey: 'sonarr:4:s1', contentIdentity: 'i', missingFingerprint: 'm', unit: { key: 'sonarr:4:s1', kind: 'tv', arr: 'sonarr', serviceId: 4, externalId: 44, title: 'Show', altTitles: [], season: { seasonNumber: 1, missing: [{ episodeId: 101, episodeNumber: 1, absoluteEpisodeNumber: null, title: 'Episode' }] } }, status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null, lastObservedAt: at, lastQueueObservedAt: at, queueObservationKnown: true, blockedReason: null };
  const owner = state.claimUnit(item.workKey, new Date(at))!;
  state.applyWorkReconciliation({ key: item.workKey, token: owner, work: item, intentUpdates: [] });
  state.applyWorkQueueObservation({ key: item.workKey, token: owner, observedAt: at, known: true, coverage: [] });
  state.releaseClaim(item.workKey, owner);
  const stack = { config: { DRY_RUN: true, LLM_MODEL: 'test', CYCLE_INTERVAL_MIN: 5, LOG_LEVEL: 'silent', HTTP_PORT: 7877, HTTP_HOST: '127.0.0.1', DB_PATH: ':memory:' }, state, runner: { cycle: async () => ({ units: 0, searched: 0, grabbed: 0, dryRunGrabs: 0, manualFlagged: 0, skipped: 0 }) }, logger: pino({ level: 'silent' }) } as unknown as Stack;
  stack.createSnapshot = () => stack;
  const app = await buildApp(stack); resources.push({ app, state });
  const seed = (episodes: Episode[], overrides: Partial<WorkItem> = {}, coverage: IntentCoverage[] = [], known = true) => {
    const missing = episodes.filter((episode) => episode.monitored && !episode.hasFile).map((episode) => ({ episodeId: episode.id, episodeNumber: episode.episodeNumber, absoluteEpisodeNumber: episode.absoluteEpisodeNumber, title: episode.title }));
    const work: WorkItem = { ...item, status: missing.length ? 'ready' : episodes.every((episode) => episode.hasFile) ? 'fulfilled' : 'inactive',
      unit: { ...item.unit, season: { seasonNumber: 1, missing } }, ...overrides };
    const token = state.claimUnit(item.workKey, new Date(at))!;
    try {
      state.applyWorkReconciliation({ key: item.workKey, token, work, intentUpdates: [], episodeObservations: episodes });
      state.applyWorkQueueObservation({ key: item.workKey, token, observedAt: at, known, coverage });
    } finally { state.releaseClaim(item.workKey, token); }
  };
  const episode = (number: number, change: Partial<Episode> = {}): Episode => ({ id: 100 + number, seriesId: 4, seasonNumber: 1, episodeNumber: number, absoluteEpisodeNumber: null, title: `Episode ${number}`, monitored: true, hasFile: false,
    airDate: '2020-01-01', airDateUtc: '2020-01-01T23:00:00Z', ...change });
  const url = '/api/operations/episodes?workKey=sonarr%3A4%3As1';
  return { app, state, at, item, seed, episode, url };
}
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.app.close(); resource.state.close(); } });

describe('episode progress API', () => {
  it('shows caught-up awaiting-airtime progress and shares the same summary with the season list', async () => {
    const run = await setup();
    const future = new Date(Date.parse(run.at) + 7 * 86400000).toISOString();
    run.seed([run.episode(1, { hasFile: true }), run.episode(2, { airDateUtc: future })], { status: 'waiting-release', blockedReason: 'waiting-release' });
    const detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.summary).toMatchObject({ knowledge: 'known', completion: 'caught-up', lifecycle: 'airing', nextEligibilityAt: future,
      counts: { total: 2, imported: 1, airedMissing: 0, future: 1, held: 0, downloading: 0 } });
    expect(detail.items.map((row: { progress: string }) => row.progress)).toEqual(['imported', 'waiting-air-date']);
    const list = (await run.app.inject({ method: 'GET', url: '/api/operations/work' })).json();
    expect(list.items[0].episodeProgress).toEqual(detail.summary);
  });

  it('counts healthy observed and reserved overlap once and leaves an unrelated aired episode ready', async () => {
    const run = await setup();
    run.seed([run.episode(1), run.episode(2)]);
    const coverage: IntentCoverage[] = [{ workKey: run.item.workKey, episodeIds: [101], basis: 'explicit-episodes' }];
    const token = run.state.claimUnit(run.item.workKey, new Date(run.at))!;
    const captured = run.state.beginGrab({ key: run.item.workKey, token, fingerprint: run.item.missingFingerprint,
      release: { arr: 'sonarr', indexerId: 1, guid: 'synthetic-source', infoHash: null, releaseTitle: 'Show.S01E01' }, coverage, now: run.at,
      deadline: new Date(Date.parse(run.at) + 1800000).toISOString() });
    if (!captured.ok) throw new Error(captured.reason);
    run.state.confirmGrab({ intentId: captured.intentId, ownerToken: token, now: run.at });
    run.state.releaseClaim(run.item.workKey, token);
    run.seed([run.episode(1), run.episode(2)], { blockedReason: 'queue-active' }, coverage);
    const detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.items.map((row: { progress: string }) => row.progress)).toEqual(['downloading', 'ready']);
    expect(detail.summary.counts).toMatchObject({ total: 2, downloading: 1, held: 0, ready: 1 });
    const list = (await run.app.inject({ method: 'GET', url: '/api/operations/work' })).json();
    expect(list.items[0].episodeProgress).toEqual(detail.summary);
  });

  it('shows independent availability retries without counting cooled or imported episodes as ready', async () => {
    const run = await setup();
    run.seed([run.episode(1), run.episode(2, { hasFile: true })]);
    const retry = new Date(Date.parse(run.at) + 6 * 3600000).toISOString();
    const token = run.state.claimUnit(run.item.workKey, new Date(run.at))!;
    run.state.recordEpisodeAttempt({ key: run.item.workKey, token, episodeIds: [101], now: run.at, nextSearchAt: retry, outcome: 'legacy-availability' });
    run.state.releaseClaim(run.item.workKey, token);
    const detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.summary).toMatchObject({ nextRetryAt: retry, counts: { ready: 0, waitingRelease: 1, imported: 1 } });
    expect(detail.items[0]).toMatchObject({ progress: 'waiting-release', nextSearchAt: retry });
  });

  it.each([false, true])('distinguishes known inventory imports from finished airing (finale=%s)', async (finale) => {
    const run = await setup();
    run.seed([run.episode(1, { hasFile: true, finaleType: finale ? 'season' : null })]);
    const response = await run.app.inject({ method: 'GET', url: run.url });
    expect(response.statusCode).toBe(200); // terminal history remains addressable
    expect(response.json().summary).toMatchObject({ completion: 'imported', lifecycle: finale ? 'finished' : 'unknown' });
  });

  it('retains broad safety explanations even for an episode with a future airtime', async () => {
    const run = await setup();
    const future = new Date(Date.parse(run.at) + 86400000).toISOString();
    run.seed([run.episode(1), run.episode(2, { airDateUtc: future })], { status: 'manual', blockedReason: 'queue-review' });
    const detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.items[1]).toMatchObject({ progress: 'held', holdReason: 'queue-review', eligibleAt: future });
  });

  it('does not treat ordinary unparseable candidate diagnostics as a season-wide hold', async () => {
    const run = await setup();
    run.seed([run.episode(1)]);
    run.state.flagManualReview(run.item.workKey, 'unparseable-title');
    const detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.items[0].progress).toBe('ready');
    expect(detail.summary.counts.ready).toBe(1);
  });

  it('paginates stable episode labels, redacts source titles, and performs no scheduling mutations', async () => {
    const run = await setup();
    run.seed([run.episode(3), run.episode(1, { title: 'Episode https://synthetic.invalid/?apikey=never-show' }), run.episode(2)]);
    const mutate = vi.spyOn(run.state, 'applyWorkReconciliation');
    const claim = vi.spyOn(run.state, 'claimUnit');
    const start = vi.spyOn(run.state, 'startSearch');
    const first = await run.app.inject({ method: 'GET', url: `${run.url}&limit=1&offset=0` });
    const second = await run.app.inject({ method: 'GET', url: `${run.url}&limit=1&offset=1` });
    expect(first.json()).toMatchObject({ total: 3, items: [{ episodeNumber: 1 }] });
    expect(second.json()).toMatchObject({ total: 3, items: [{ episodeNumber: 2 }] });
    expect(first.body).not.toMatch(/never-show|apikey|episodeId|guid|ownerToken|infoHash/);
    expect(mutate).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'stale'] as const)('does not claim readiness or completion from %s observations', async (knowledge) => {
    const run = await setup(knowledge === 'stale' ? 48 * 3600000 : 0);
    run.seed([run.episode(1, { hasFile: true })], {}, [], knowledge !== 'unknown');
    const detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.summary).toMatchObject({ knowledge, completion: 'unknown', counts: null });
    expect(detail.items[0].progress).toBe(knowledge);
  });

  it('does not project historical rows from a different content identity as current imports', async () => {
    const run = await setup();
    run.seed([run.episode(1, { hasFile: true })]);
    const current = run.state.getWorkItem(run.item.workKey)!;
    const token = run.state.claimUnit(run.item.workKey, new Date(run.at))!;
    run.state.applyWorkReconciliation({ key: run.item.workKey, token, work: { ...current, unit: { ...current.unit, externalId: 999 }, contentIdentity: 'new' }, intentUpdates: [] });
    run.state.releaseClaim(run.item.workKey, token);
    const detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail).toMatchObject({ items: [], total: 0, summary: { knowledge: 'unknown', counts: null, completion: 'unknown' } });
  });

  it('does not infer completion when a previously tracked target is absent from episode evidence', async () => {
    const run = await setup();
    const observed = run.episode(1, { hasFile: true });
    run.seed([observed], { status: 'inactive', unit: { ...run.item.unit, season: { seasonNumber: 1,
      missing: [{ episodeId: 102, episodeNumber: 2, absoluteEpisodeNumber: null, title: 'Unobserved historical target' }] } } });
    const detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.summary).toMatchObject({ knowledge: 'unknown', completion: 'unknown', counts: null });
  });

  it('distinguishes unknown timing from a conservative date-only fallback', async () => {
    const run = await setup();
    run.seed([run.episode(1, { airDate: null, airDateUtc: null }), run.episode(2, { airDateUtc: 'invalid' })]);
    const detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.items).toMatchObject([{ timingBasis: 'unknown', progress: 'timing-unknown' }, { timingBasis: 'date-only', progress: 'ready' }]);
    expect(detail.summary.counts).toMatchObject({ timingUnknown: 1, ready: 1 });
  });

  it('shows an uncertain exact reservation as held without hiding an independently ready sibling', async () => {
    const run = await setup();
    run.seed([run.episode(1), run.episode(2)]);
    const token = run.state.claimUnit(run.item.workKey, new Date(run.at))!;
    const captured = run.state.beginGrab({ key: run.item.workKey, token, fingerprint: run.item.missingFingerprint,
      release: { arr: 'sonarr', indexerId: 1, guid: 'synthetic-uncertain', infoHash: null, releaseTitle: 'Show.S01E01' },
      coverage: [{ workKey: run.item.workKey, episodeIds: [101], basis: 'explicit-episodes' }], now: run.at,
      deadline: new Date(Date.parse(run.at) + 1800000).toISOString() });
    if (!captured.ok) throw new Error(captured.reason);
    run.state.markGrabUncertain({ intentId: captured.intentId, ownerToken: token, now: run.at });
    run.state.releaseClaim(run.item.workKey, token);
    run.seed([run.episode(1), run.episode(2)], { blockedReason: 'active-intent' });
    const detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.items).toMatchObject([{ progress: 'held', holdReason: 'uncertain-download' }, { progress: 'ready' }]);
    expect(detail.summary.counts).toMatchObject({ held: 1, downloading: 0, ready: 1 });
  });

  it('explains operational backoff and ordinary episode cooldown separately from availability', async () => {
    const run = await setup();
    const deadline = new Date(Date.parse(run.at) + 3600000).toISOString();
    run.seed([run.episode(1)], { status: 'backoff', lastOutcome: 'rate-limited', nextSearchAt: deadline });
    let detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.items[0]).toMatchObject({ progress: 'retry-backoff', holdReason: 'rate-limited', nextSearchAt: deadline });
    expect(detail.summary.counts.ready).toBe(0);
    run.seed([run.episode(1)]);
    const token = run.state.claimUnit(run.item.workKey, new Date(run.at))!;
    run.state.recordEpisodeAttempt({ key: run.item.workKey, token, episodeIds: [101], now: run.at, nextSearchAt: deadline, outcome: 'dry-run' });
    run.state.releaseClaim(run.item.workKey, token);
    detail = (await run.app.inject({ method: 'GET', url: run.url })).json();
    expect(detail.items[0]).toMatchObject({ progress: 'cooldown', nextSearchAt: deadline });
    expect(detail.summary.counts).toMatchObject({ ready: 0, waitingRelease: 0 });
  });
  it('returns unknown rather than fabricating progress when current episode observations are absent', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/operations/episodes?workKey=sonarr%3A4%3As1&limit=50&offset=0' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ workKey: 'sonarr:4:s1', items: [], total: 0, summary: { knowledge: 'unknown', completion: 'unknown', counts: null } });
  });

  it('validates work keys and paginates safely', async () => {
    const { app, state, at } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/operations/episodes?limit=1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/operations/episodes?workKey=missing' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/operations/episodes?workKey=%20%20' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/operations/episodes?workKey=sonarr%3A4%3As1&limit=101' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/operations/work?limit=101' })).statusCode).toBe(400);
    const key = 'radarr:9';
    const token = state.claimUnit(key, new Date(at))!;
    state.applyWorkReconciliation({ key, token, work: { workKey: key, contentIdentity: 'movie', missingFingerprint: 'movie',
      unit: { key, kind: 'movie', arr: 'radarr', serviceId: 9, externalId: 99, title: 'Movie', altTitles: [] },
      status: 'ready', lastSearchAt: null, nextSearchAt: null, failCount: 0, lastOutcome: null, lastObservedAt: at,
      lastQueueObservedAt: null, queueObservationKnown: false, blockedReason: null }, intentUpdates: [] });
    state.releaseClaim(key, token);
    expect((await app.inject({ method: 'GET', url: '/api/operations/episodes?workKey=radarr%3A9' })).statusCode).toBe(404);
  });
});
