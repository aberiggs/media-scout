/** Safe, synthetic UI/HTTP fixture. It never reads real credentials or contacts real services. */
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { buildStack } from '../src/compose';
import { loadConfig } from '../src/config';
import { buildApp } from '../src/daemon';
import { defaultSettings } from '../src/search/settings';
import type { AgentRequest } from '../src/search/agent-contracts';
import { releaseSchema } from '../src/types/prowlarr';
import { Http } from '../src/http';
import { ProwlarrClient } from '../src/clients/prowlarr';

const host = '0.0.0.0';
const port = Number(process.env.PREVIEW_SEARCH_PORT ?? process.env.PORT ?? 4787);
const settings = structuredClone(defaultSettings);
settings.integrations.prowlarr = { url: 'http://synthetic.invalid', apiKey: 'fixture-only', tvClientId: null, movieClientId: null };
settings.ai.apiKey = 'fixture-only'; settings.ai.model = 'fixture-no-provider-calls';
settings.safety.dryRun = true;

type Mode = 'success' | 'reject-after-first' | 'accepted-timeout';
let mode: Mode = 'success';
let accepted = 0;
let upstreamRequests = 0;
const upstream = Fastify({ logger: false });
const requestBodies: unknown[] = [];
upstream.get('/api/v1/downloadclient', async () => [{
  id: 901, name: 'Synthetic qBittorrent', enable: true, protocol: 'torrent',
  supportsCategories: true, categories: [],
  fields: [{ name: 'category', value: 'tv' }, { name: 'password' }],
}]);
upstream.post('/api/v1/search', async (_request, reply) => {
  upstreamRequests++;
  requestBodies.push(_request.body);
  accepted++;
  const count = accepted;
  if (mode === 'reject-after-first' && count > 1) return reply.code(422).send({ message: 'Synthetic rejection after one accepted release.' });
  if (mode === 'accepted-timeout') {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    return reply.send({ accepted: true });
  }
  return reply.send({ accepted: true });
});
await upstream.listen({ host: '127.0.0.1', port: 0 });
const upstreamAddress = upstream.server.address();
if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Synthetic upstream failed to bind.');
const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`;
settings.integrations.prowlarr.url = upstreamUrl;

const clients = () => ({
  prowlarr: new ProwlarrClient(new Http({ baseUrl: upstreamUrl, apiKey: 'fixture-only', timeoutMs: 300 })),
});

const stack = buildStack({
  config: loadConfig({ DB_PATH: ':memory:', HTTP_PORT: String(port), HTTP_HOST: host, LOG_LEVEL: 'silent' }),
  initialSettings: settings,
  clients,
});

const now = Date.now();
const secretFingerprint = createHash('sha256').update(`prowlarr\0${settings.integrations.prowlarr.url}\0${settings.integrations.prowlarr.apiKey}`).digest('hex');
const baseRequest: AgentRequest = {
  version: 1, prompt: 'Find Signal Harbor season two', kind: 'show', scope: 'season', titles: ['Signal Harbor'], externalIds: {},
  intents: [{ id: 'season-two', type: 'season', season: 2 }], targetIds: [], arrTargetIds: [], context: [], contextEpisodes: [], showMetadata: {}, preferences: {},
};

function release(candidateId: string, title: string, indexerId: number, categories: number[]) {
  return releaseSchema.parse({
    guid: `fixture-${candidateId}`, age: 5, size: 1_240_000_000, files: 12, grabs: 40, indexerId, indexer: 'Synthetic indexer only',
    subGroup: null, title, tvdbId: null, tmdbId: null, publishDate: '2026-10-01T00:00:00Z', downloadUrl: null,
    indexerFlags: [], categories: categories.map(id => ({ id, name: `Synthetic ${id}` })), magnetUrl: null, infoHash: null,
    seeders: 140, leechers: 4, protocol: 'torrent', downloadClientId: null,
  });
}

function seedSearch(id: string, prompt: string, request: AgentRequest, plan: Record<string, unknown>, candidateRows: Array<{ id: string; title: string; expiresAt?: number }>) {
  const candidateEvidence = candidateRows.map((row, index) => ({
    candidateId: row.id,
    observations: [{ title: row.title, indexer: 'Synthetic indexer only', size: 1_240_000_000 - index * 100_000_000, seeders: 140 - index * 30 }],
  }));
  stack.runtime.store.createSearch({
    searchId: id, prompt: JSON.stringify({ version: 1, request }), status: 'matched', createdAt: now,
  });
  stack.runtime.store.setSetting(`search-source:${id}`, 'manual');
  candidateRows.forEach((row, index) => {
    const item = release(row.id, row.title, 91 + index, [5000]);
    stack.runtime.store.addCandidate({
      searchId: id, candidateId: row.id, safe: candidateEvidence[index],
      privateData: { release: item, physicalKey: `fixture-physical-${id}-${row.id}`, sourceFingerprint: secretFingerprint },
      expiresAt: row.expiresAt ?? now + 60 * 60_000,
    });
  });
  stack.runtime.store.finishSearch(id, 'matched', {
    version: 1, request, plan, candidateEvidence,
    counts: { decisions: 4, searches: 3, candidates: candidateRows.length },
    diagnostics: { modelTurns: 3, stopReason: 'fixture', elapsedMs: 410, usage: { inputTokens: 820, outputTokens: 140 } },
  }, now);
  return { searchId: id, prompt, status: 'matched', source: 'manual', kind: request.kind === 'movie' ? 'movie' : 'tv', createdAt: new Date(now).toISOString() };
}

const seasonRows = [
  { id: 'signal-pack-a', title: 'Signal Harbor S02 Complete 1080p WEB-DL MULTI' },
  { id: 'signal-pack-b', title: 'Signal Harbor S02E03-E06 1080p WEB-DL' },
];
const seasonPlan = {
  version: 2, planId: 'fixture-plan-season', status: 'matched',
  selections: [
    { candidateId: seasonRows[0]!.id, coverage: 'Season 2 episodes 1–5, with overlap on episode 3', reason: 'Broad pack supplies the opening run with stronger seed availability.', uncertainty: '' },
    { candidateId: seasonRows[1]!.id, coverage: 'Season 2 episodes 3–6', reason: 'Complements the first pack and reaches the finale; episode 3 overlaps usefully.', uncertainty: 'Pack boundaries are inferred from the title.' },
  ],
  covered: ['Episodes 1–6, with episode 3 in both releases'], gaps: ['Episode 7 was not found'], deferred: [], scopeGaps: ['Episode 7'],
  extras: [], usefulOverlap: ['Episode 3'], broadCoverage: 'partial',
  coverage: { covered: ['Episodes 1–6'], gaps: ['Episode 7 was not found'], deferred: [], broad: { status: 'partial', gaps: ['Episode 7'] } },
  warnings: ['Coverage is inferred from release names and indexer metadata.'],
};
const seasonItem = seedSearch('fixture-season-overlap-gap', 'Signal Harbor season two', baseRequest, seasonPlan, seasonRows);
const uncertainItem = seedSearch('fixture-uncertain-set', 'Signal Harbor uncertain submission', {
  ...baseRequest, prompt: 'Signal Harbor uncertain submission',
}, { ...seasonPlan, planId: 'fixture-plan-uncertain' }, seasonRows);
const recoveryItem = seedSearch('fixture-transport-recovery', 'Signal Harbor response recovery', {
  ...baseRequest, prompt: 'Signal Harbor response recovery',
}, { ...seasonPlan, planId: 'fixture-plan-recovery' }, seasonRows);

const movieRequest: AgentRequest = {
  ...baseRequest, prompt: 'Find Glass Orchard (2024)', kind: 'movie', scope: 'movie', titles: ['Glass Orchard'], year: 2024,
  intents: [{ id: 'glass-orchard-2024', type: 'movie' }],
};
const moviePlan = {
  version: 2, planId: 'fixture-plan-movie', status: 'matched',
  selections: [{ candidateId: 'glass-orchard', coverage: 'Complete feature film', reason: 'Single feature release with matching year and strong metadata.', uncertainty: '' }],
  covered: ['Feature film'], gaps: [], deferred: [], scopeGaps: [], extras: [], usefulOverlap: [], broadCoverage: 'complete',
  coverage: { covered: ['Feature film'], gaps: [], deferred: [], broad: { status: 'complete', gaps: [] } },
};
const movieItem = seedSearch('fixture-movie', movieRequest.prompt, movieRequest, moviePlan, [{ id: 'glass-orchard', title: 'Glass Orchard (2024) 1080p WEB-DL' }]);

const stalePlan = { ...seasonPlan, planId: 'fixture-plan-stale', selections: [{ candidateId: 'missing-candidate', coverage: 'Season 2', reason: 'Old fixture candidate', uncertainty: '' }] };
const staleItem = seedSearch('fixture-stale-confirmation', 'Stale Signal Harbor plan', baseRequest, stalePlan, []);
const expiredPlan = { ...moviePlan, planId: 'fixture-plan-expired', selections: [{ candidateId: 'expired-movie', coverage: 'Complete feature film', reason: 'Expired candidate sample', uncertainty: '' }] };
const expiredItem = seedSearch('fixture-expired-candidate', 'Expired Glass Orchard candidate', movieRequest, expiredPlan, [{ id: 'expired-movie', title: 'Glass Orchard (2024) old candidate', expiresAt: now - 1 }]);
const noMatchPlan = {
  version: 2, planId: 'fixture-plan-no-match', status: 'no-match', selections: [],
  covered: [], gaps: ['No suitable release observed'], deferred: [], scopeGaps: [],
  broadCoverage: 'none', coverage: { covered: [], gaps: ['No suitable release observed'], deferred: [], broad: { status: 'none', gaps: [] } },
};
seedSearch('fixture-no-match', 'No suitable release fixture', baseRequest, noMatchPlan, []);
stack.runtime.store.finishSearch('fixture-no-match', 'no-match', {
  version: 1, request: baseRequest, plan: noMatchPlan, candidateEvidence: [],
  counts: { decisions: 3, searches: 2, candidates: 0 },
}, now);

const app = await buildApp(stack, { webRoot: process.env.PREVIEW_SEARCH_WEB_ROOT ?? '/tmp/opencode/media-scout-56-web-build' });
function localOnly(request: { ip: string }) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) throw new Error('fixture-route-loopback-only');
}
app.get('/__fixture', async request => {
  localOnly(request);
  return { scenarios: [seasonItem, movieItem, staleItem, expiredItem, uncertainItem, recoveryItem], upstreamMode: mode, upstreamRequests, accepted, requestBodies };
});
app.post('/__fixture', async (request, reply) => {
  localOnly(request);
  const body = request.body as { action?: string; mode?: Mode; dryRun?: boolean };
  if (body.action === 'reset') {
    mode = 'success'; accepted = 0; upstreamRequests = 0;
    stack.runtime.store.setSetting('application-settings', { ...stack.runtime.getSettings(), safety: { dryRun: body.dryRun ?? true } });
    return reply.send({ ok: true, mode, dryRun: stack.runtime.getSettings().safety.dryRun });
  }
  if (body.action === 'mode' && ['success', 'reject-after-first', 'accepted-timeout'].includes(body.mode ?? '')) {
    mode = body.mode!;
    accepted = 0;
    return reply.send({ ok: true, mode });
  }
  return reply.code(400).send({ error: 'Use action=reset or action=mode with a supported synthetic mode.' });
});

await app.listen({ port, host });
console.log(`Synthetic UI fixture: http://127.0.0.1:${port}/#search`);
console.log(`Scenarios: ${[seasonItem, movieItem, staleItem, expiredItem].map(item => item.searchId).join(', ')}`);
console.log(`Synthetic modes via POST /__fixture: success, reject-after-first, accepted-timeout (dryRun reset defaults to true).`);
const stop = async () => { await app.close(); await upstream.close(); await stack.runtime.close(); };
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
