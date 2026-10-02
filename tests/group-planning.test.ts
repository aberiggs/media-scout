import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LLMClient } from '../src/clients/llm';
import type { GroupCandidate, PlanningContext, WorkGroup } from '../src/core/group-types';
import { Planner } from '../src/core/planner';
import { Picker } from '../src/core/picker';
import {
  buildPlanningContext,
  buildWorkGroups,
  serializeGroupPickerInput,
  serializeGroupPlannerInput,
} from '../src/core/media-context';
import type { QueueReads, ReconciledWork } from '../src/core/work-queue';
import type { GrabIntent, WorkItem } from '../src/core/work-queue-types';
import type { LibrarySnapshot, WorkUnit } from '../src/core/watcher';
import type { Release } from '../src/types/prowlarr';
import type { Episode, Series } from '../src/types/sonarr';

const NOW = '2026-10-01T12:00:00.000Z';

class ScriptLLM implements LLMClient {
  readonly calls: Array<{ system: string; user: string; label: string; schema: z.ZodType<unknown>; jsonSchema?: { name: string; schema: Record<string, unknown> } }> = [];

  constructor(private readonly output: unknown) {}

  async json<T>(args: { system: string; user: string; schema: z.ZodType<T>; label: string; jsonSchema?: { name: string; schema: Record<string, unknown> } }): Promise<T> {
    this.calls.push({ system: args.system, user: args.user, label: args.label, schema: args.schema, jsonSchema: args.jsonSchema });
    return args.schema.parse(this.output);
  }
}

function unit(seasonNumber: number, episodes: Array<{ id: number; number: number; title: string }>): WorkUnit {
  return {
    key: `sonarr:7:s${seasonNumber}`, kind: 'tv', arr: 'sonarr', serviceId: 7, externalId: 77,
    title: 'The Example Show', altTitles: ['The Alias'], seriesType: 'standard',
    season: { seasonNumber, missing: episodes.map((episode) => ({
      episodeId: episode.id, episodeNumber: episode.number, absoluteEpisodeNumber: null, title: episode.title,
    })) },
  };
}

function reconciled(unitValue: WorkUnit, status: WorkItem['status'], options: {
  eligibleUnit?: WorkUnit | null;
  blockedReason?: string | null;
  activeCoverage?: ReconciledWork['activeCoverage'];
  nextSearchAt?: string | null;
} = {}): ReconciledWork {
  const work: WorkItem = {
    workKey: unitValue.key,
    contentIdentity: `${unitValue.arr}:${unitValue.serviceId}:${unitValue.externalId}:${unitValue.kind}`,
    missingFingerprint: 'fingerprint',
    unit: unitValue,
    status,
    lastSearchAt: null,
    nextSearchAt: options.nextSearchAt ?? null,
    failCount: 0,
    lastOutcome: null,
    lastObservedAt: NOW,
    lastQueueObservedAt: NOW,
    queueObservationKnown: true,
    blockedReason: options.blockedReason ?? null,
  };
  return {
    work,
    eligibleUnit: options.eligibleUnit === undefined ? unitValue : options.eligibleUnit,
    queueCoverage: [], queueFailureRefs: [], activeCoverage: options.activeCoverage ?? [],
    blockedReason: options.blockedReason ?? null, intentUpdates: [], manualReviewReason: null,
  };
}

function groupFixture(): WorkGroup {
  const first = unit(1, [{ id: 101, number: 1, title: 'Library Pilot' }, { id: 102, number: 2, title: 'Library Follow-up' }]);
  const second = unit(2, [{ id: 201, number: 1, title: 'Library Return' }, { id: 202, number: 2, title: 'Library Later' }]);
  const held = [{ workKey: second.key, episodeIds: [201], basis: 'explicit-episodes' as const }];
  return {
    key: 'sonarr:7',
    members: [
      reconciled(first, 'ready'),
      reconciled(second, 'cooldown', { eligibleUnit: unit(2, [{ id: 202, number: 2, title: 'Library Later' }]), activeCoverage: held }),
    ],
    targets: [first, second],
    dueTargetIndices: [0],
  };
}

function planningContext(overrides: Partial<PlanningContext> = {}): PlanningContext {
  return {
    openWork: [
      { workKey: 'sonarr:7:s1', title: 'The Example Show', kind: 'tv', seriesType: 'standard', seasonNumber: 1, missingCount: 1, eligibleCount: 1, heldCount: 0, expectedTargets: [{ description: 'Library Pilot', seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: null }], status: 'ready', nextSearchAt: null },
      { workKey: 'sonarr:7:s2', title: 'The Example Show', kind: 'tv', seriesType: 'standard', seasonNumber: 2, missingCount: 1, eligibleCount: 1, heldCount: 0, expectedTargets: [{ description: 'Library Return', seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: null }], status: 'cooldown', nextSearchAt: '2026-10-01T18:00:00.000Z' },
      { workKey: 'sonarr:7:s3', title: 'The Example Show', kind: 'tv', seriesType: 'standard', seasonNumber: 3, missingCount: 1, eligibleCount: 0, heldCount: 1, expectedTargets: [{ description: 'Future Library Target', seasonNumber: 3, episodeNumber: 1, absoluteEpisodeNumber: null }], status: 'waiting-release', nextSearchAt: null },
    ],
    activeDownloads: [],
    sourceKnowledge: [
      { arr: 'sonarr', library: { kind: 'known', observedAt: NOW }, queue: { kind: 'known', observedAt: NOW } },
      { arr: 'radarr', library: { kind: 'known', observedAt: NOW }, queue: { kind: 'known', observedAt: NOW } },
    ],
    ...overrides,
  };
}

function release(title: string, overrides: Partial<Release> = {}): Release {
  return {
    guid: `guid-${title}`, age: 3, size: 1_000, files: 1, grabs: null, indexerId: 4, indexer: 'Index',
    subGroup: null, title, tvdbId: 77, tmdbId: null, publishDate: NOW,
    downloadUrl: 'https://secret.test/dl?apikey=secret', indexerFlags: ['freeleech'], categories: [],
    magnetUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
    infoHash: '0123456789abcdef0123456789abcdef01234567', seeders: null, leechers: null,
    protocol: 'torrent', downloadClientId: null, ...overrides,
  };
}

function candidate(options: {
  physicalSlot: number;
  release?: Partial<Release>;
  requested: Array<{ workKey: string; episodeIds: number[]; basis?: 'explicit-episodes' | 'inferred-season-pack' }>;
  capture?: Array<{ workKey: string; episodeIds: number[]; basis?: 'explicit-episodes' | 'inferred-season-pack' }>;
  extraSeasons?: number[];
}): GroupCandidate {
  const coverage = (items: typeof options.requested) => items.map((item) => ({
    workKey: item.workKey, episodeIds: item.episodeIds, basis: item.basis ?? 'explicit-episodes' as const,
  }));
  return {
    release: release('Example S01-S02 Combined 1080p', options.release),
    physicalSlot: options.physicalSlot,
    parsed: { kind: 'claims', seasonClaims: [{ seasonNumber: 1, episodes: null }, { seasonNumber: 2, episodes: null }], absoluteEpisodes: null, unqualifiedEpisodes: null, wholeSeries: false },
    requestedFootprint: coverage(options.requested),
    capture: coverage(options.capture ?? options.requested),
    extraSeasons: options.extraSeasons ?? [],
  };
}

function queues(overrides: Partial<QueueReads> = {}): QueueReads {
  return {
    sonarr: { kind: 'known', records: [], observedAt: NOW },
    radarr: { kind: 'known', records: [], observedAt: NOW },
    ...overrides,
  };
}

function episode(id: number, seasonNumber: number, episodeNumber: number, airDate: string | null, overrides: Partial<Episode> = {}): Episode {
  return { id, seriesId: 7, seasonNumber, episodeNumber, absoluteEpisodeNumber: null, title: `Library ${id}`, airDate, monitored: true, hasFile: false, ...overrides };
}

function snapshot(episodes: Episode[], seriesOverrides: Partial<Series> = {}): LibrarySnapshot {
  const series: Series = {
    id: 7, tvdbId: 77, title: 'The Example Show', titleSlug: 'example-show', seriesType: 'standard',
    monitored: true, seasons: [], alternateTitles: [{ title: 'The Alias' }], ...seriesOverrides,
  };
  return { observedAt: NOW, sonarr: { known: true, series: [{ series, known: true, episodes }] }, radarr: { known: true, movies: [] } };
}

describe('group planner and picker', () => {
  it('plans broad queries with actual target intent, valid unique indices, and full compact context', async () => {
    const group = groupFixture();
    const context = planningContext();
    const output = { queries: [
      { query: 'The Example Show S01 S02', categories: [5000], targetIndices: [0, 1] },
      { query: 'The Alias S01 S02', categories: [5070, 5000], targetIndices: [0] },
    ] };
    const llm = new ScriptLLM(output);
    const planned = await new Planner({ llm }).planGroup({ group, context });
    expect(planned).toEqual(output.queries);
    expect(llm.calls[0]?.label).toBe('planner:group:sonarr:7');
    expect(llm.calls[0]?.jsonSchema?.name).toBe('group_planner_queries');
    const payload = JSON.parse(llm.calls[0]!.user) as Record<string, unknown>;
    expect(payload.dueTargetIndices).toEqual([0]);
    expect(payload.context).toMatchObject({ openWork: expect.arrayContaining([expect.objectContaining({ status: 'waiting-release' })]) });
    expect(llm.calls[0]!.system).toMatch(/do not restrict .*resolution/i);
    expect(planned.flatMap((query) => query.targetIndices)).toContain(0);
  });

  it.each([
    ['out of range target', [{ query: 'q', categories: [5000], targetIndices: [9] }]],
    ['duplicate target in a query', [{ query: 'q', categories: [5000], targetIndices: [0, 0] }]],
    ['due target omitted', [{ query: 'q', categories: [5000], targetIndices: [1] }]],
  ])('rejects invalid group query intent (%s)', async (_name, queriesOutput) => {
    const llm = new ScriptLLM({ queries: queriesOutput });
    await expect(new Planner({ llm }).planGroup({ group: groupFixture(), context: planningContext() })).rejects.toThrow();
  });

  it('selects one competitive combined physical pack and does not union variant claims', async () => {
    const group = groupFixture();
    const combined = candidate({ physicalSlot: 5, requested: [
      { workKey: 'sonarr:7:s1', episodeIds: [101] },
      { workKey: 'sonarr:7:s2', episodeIds: [202] },
    ], extraSeasons: [3] });
    const sameHashVariant = candidate({ physicalSlot: 6, release: { title: 'Alias S02 pack', infoHash: combined.release.infoHash }, requested: [
      { workKey: 'sonarr:7:s2', episodeIds: [202] },
    ] });
    const llm = new ScriptLLM({ selection: { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'one combined pack is competitive' } });
    const selection = await new Picker({ llm, mediaPreferences: 'Prefer 1080p over 4K.' }).pickGroup({
      group, context: planningContext(), candidates: [combined, sameHashVariant],
    });
    expect(selection.releaseIndices).toEqual([0]);
    const payload = JSON.parse(llm.calls[0]!.user) as { candidates: Array<Record<string, unknown>>; mediaPreferences: string };
    expect(payload.mediaPreferences).toBe('Prefer 1080p over 4K.');
    expect(payload.candidates[0]!.requestedFootprint).toHaveLength(2);
    expect(payload.candidates[1]!.requestedFootprint).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toMatch(/guid-|0123456789abcdef|magnet:|https?:|apikey|downloadClientId/);
    expect(llm.calls[0]!.system).toMatch(/inferred.*not verified/i);
    expect(llm.calls[0]!.system).toMatch(/expectedEpisodeTitle|library target descriptions/i);
  });

  it.each([
    ['duplicate candidate indices', { verdict: 'grab', releaseIndices: [0, 0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'x' }],
    ['out of range candidate index', { verdict: 'grab', releaseIndices: [4], manualTargetIndices: [], deferredTargetIndices: [], reason: 'x' }],
    ['more than three selected releases', { verdict: 'grab', releaseIndices: [0, 1, 2, 3], manualTargetIndices: [], deferredTargetIndices: [], reason: 'x' }],
    ['missing required selection fields', { verdict: 'manual', releaseIndices: [], reason: 'x' }],
    ['non-grab release choice', { verdict: 'skip', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'x' }],
  ])('rejects invalid provider selection as a whole (%s)', async (_name, selection) => {
    const llm = new ScriptLLM({ selection });
    await expect(new Picker({ llm }).pickGroup({
      group: groupFixture(), context: planningContext(), candidates: [candidate({ physicalSlot: 0, requested: [{ workKey: 'sonarr:7:s1', episodeIds: [101] }] })],
    })).rejects.toThrow();
  });

  it('rejects selected releases with overlapping requested footprints, even if captures differ', async () => {
    const llm = new ScriptLLM({ selection: { verdict: 'grab', releaseIndices: [0, 1], manualTargetIndices: [], deferredTargetIndices: [], reason: 'overlap' } });
    await expect(new Picker({ llm }).pickGroup({
      group: groupFixture(), context: planningContext(), candidates: [
        candidate({ physicalSlot: 0, release: { guid: 'overlap-a', infoHash: null }, requested: [{ workKey: 'sonarr:7:s1', episodeIds: [101, 102] }], capture: [{ workKey: 'sonarr:7:s1', episodeIds: [101] }] }),
        candidate({ physicalSlot: 1, release: { guid: 'overlap-b', infoHash: null }, requested: [{ workKey: 'sonarr:7:s1', episodeIds: [102] }], capture: [{ workKey: 'sonarr:7:s1', episodeIds: [102] }] }),
      ],
    })).rejects.toThrow(/overlap/i);
  });

  it('rejects duplicate physical slots/source identity and held target selection', async () => {
    const duplicateLLM = new ScriptLLM({ selection: { verdict: 'grab', releaseIndices: [0, 1], manualTargetIndices: [], deferredTargetIndices: [], reason: 'duplicate slot' } });
    await expect(new Picker({ llm: duplicateLLM }).pickGroup({
      group: groupFixture(), context: planningContext(), candidates: [
        candidate({ physicalSlot: 0, requested: [{ workKey: 'sonarr:7:s1', episodeIds: [101] }] }),
        candidate({ physicalSlot: 0, requested: [{ workKey: 'sonarr:7:s2', episodeIds: [201] }] }),
      ],
    })).rejects.toThrow(/physical/i);

    const hashLLM = new ScriptLLM({ selection: { verdict: 'grab', releaseIndices: [0, 1], manualTargetIndices: [], deferredTargetIndices: [], reason: 'same hash variant' } });
    await expect(new Picker({ llm: hashLLM }).pickGroup({
      group: groupFixture(), context: planningContext(), candidates: [
        candidate({ physicalSlot: 0, release: { title: 'First variant', guid: 'hash-a', infoHash: 'SAMEHASH' }, requested: [{ workKey: 'sonarr:7:s1', episodeIds: [101] }] }),
        candidate({ physicalSlot: 1, release: { title: 'Different title variant', guid: 'hash-b', infoHash: 'samehash' }, requested: [{ workKey: 'sonarr:7:s2', episodeIds: [202] }] }),
      ],
    })).rejects.toThrow(/physical/i);

    const heldLLM = new ScriptLLM({ selection: { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'held' } });
    await expect(new Picker({ llm: heldLLM }).pickGroup({
      group: groupFixture(), context: planningContext(), candidates: [candidate({ physicalSlot: 0, requested: [{ workKey: 'sonarr:7:s2', episodeIds: [201] }] })],
    })).rejects.toThrow(/held|reserved/i);

    const heldExtraLLM = new ScriptLLM({ selection: { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'held extra' } });
    await expect(new Picker({ llm: heldExtraLLM }).pickGroup({
      group: groupFixture(), context: planningContext(), candidates: [candidate({ physicalSlot: 0, requested: [{ workKey: 'sonarr:7:s1', episodeIds: [101] }], extraSeasons: [2] })],
    })).rejects.toThrow(/extra season held/i);
  });

  it('validates manual/deferred target scope, disjoint capture, and three-release-only capacity deferral', async () => {
    const oneCandidate = candidate({ physicalSlot: 0, requested: [{ workKey: 'sonarr:7:s1', episodeIds: [101] }] });
    const invalid = [
      { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [99], deferredTargetIndices: [], reason: 'bad target' },
      { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [1], reason: 'capacity without cap' },
      { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [0], deferredTargetIndices: [], reason: 'capture/manual overlap' },
      { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [1], deferredTargetIndices: [1], reason: 'manual/deferred overlap' },
    ];
    for (const selection of invalid) {
      const llm = new ScriptLLM({ selection });
      await expect(new Picker({ llm }).pickGroup({ group: groupFixture(), context: planningContext(), candidates: [oneCandidate] })).rejects.toThrow();
    }
  });
});

describe('media context pure helpers', () => {
  it('groups by Arr service identity, includes only ready/cooldown eligible residual targets, and keeps waiting context', () => {
    const episodes = [
      episode(101, 1, 1, '2020-01-01'),
      episode(102, 1, 2, null),
      episode(201, 2, 1, '2020-01-01'),
      episode(202, 2, 2, '2020-01-01'),
      episode(301, 3, 1, null),
    ];
    const inventory = snapshot(episodes);
    const first = unit(1, [{ id: 101, number: 1, title: 'Library 101' }, { id: 102, number: 2, title: 'Library 102' }]);
    const second = unit(2, [{ id: 201, number: 1, title: 'Library 201' }, { id: 202, number: 2, title: 'Library 202' }]);
    const waiting = unit(3, [{ id: 301, number: 1, title: 'Future Library 301' }]);
    const rows = [
      reconciled(first, 'ready', { eligibleUnit: unit(1, [{ id: 101, number: 1, title: 'Library 101' }]) }),
      reconciled(second, 'cooldown', { eligibleUnit: unit(2, [{ id: 202, number: 2, title: 'Library 202' }]), activeCoverage: [{ workKey: second.key, episodeIds: [201], basis: 'explicit-episodes' }] }),
      reconciled(waiting, 'waiting-release', { eligibleUnit: null, blockedReason: 'waiting-release' }),
    ];
    const built = buildWorkGroups({ snapshot: inventory, rows, now: NOW });
    expect(built).toHaveLength(1);
    expect(built[0]!.members.map((row) => row.work.workKey)).toEqual(['sonarr:7:s1', 'sonarr:7:s2', 'sonarr:7:s3']);
    expect(built[0]!.targets.map((target) => target.season?.missing.map((entry) => entry.episodeId))).toEqual([[101], [202]]);
    expect(built[0]!.dueTargetIndices).toEqual([0]);

    const context = buildPlanningContext({ snapshot: inventory, rows, queues: queues(), intents: [] });
    expect(context.openWork.map((item) => item.status)).toContain('waiting-release');
    expect(context.openWork.find((item) => item.workKey === 'sonarr:7:s1')?.expectedTargets[0]?.description).toBe('Library 101');
    expect(context.sourceKnowledge.find((source) => source.arr === 'sonarr')?.queue.kind).toBe('known');
  });

  it('preserves unknown queue knowledge instead of representing it as empty and includes active row context safely', () => {
    const inventory = snapshot([episode(101, 1, 1, '2020-01-01')]);
    const work = unit(1, [{ id: 101, number: 1, title: 'Expected Library Title' }]);
    const row = reconciled(work, 'ready', { blockedReason: 'queue-unknown', eligibleUnit: null });
    const queueReads = queues({ sonarr: { kind: 'unknown', observedAt: NOW, errorCode: 'queue-http-503' } });
    const context = buildPlanningContext({ snapshot: inventory, rows: [row], queues: queueReads, intents: [] });
    expect(context.sourceKnowledge.find((source) => source.arr === 'sonarr')?.queue).toEqual({ kind: 'unknown', observedAt: NOW, errorCode: 'queue-http-503' });
    expect(buildWorkGroups({ snapshot: inventory, rows: [row], now: NOW })).toEqual([]);

    const knownContext = buildPlanningContext({
      snapshot: inventory,
      rows: [reconciled(work, 'ready')],
      queues: queues({ sonarr: { kind: 'known', observedAt: NOW, records: [{ downloadId: 'PRIVATE-DOWNLOAD', title: 'PRIVATE-DOWNLOAD Active Example S01E01', status: 'downloading', seriesId: 7, episodeId: 101, seasonNumber: 1 }] } }),
      intents: [] as GrabIntent[],
    });
    const encoded = JSON.stringify(knownContext);
    expect(knownContext.activeDownloads[0]).toMatchObject({ uncertainty: 'none', workReferences: [{ workKey: work.key, episodeIds: [101] }] });
    expect(encoded).not.toContain('PRIVATE-DOWNLOAD');
    expect(encoded).not.toContain('downloadId');

    const uncertainContext = buildPlanningContext({
      snapshot: inventory,
      rows: [row],
      queues: queues({ sonarr: { kind: 'known', observedAt: NOW, records: [{ downloadId: 'UNKNOWN-PRIVATE', title: 'Unmatched row', status: 'downloading' }] } }),
      intents: [],
      associations: [{ arr: 'sonarr', queueRef: 'download:UNKNOWN-PRIVATE', outcome: 'uncertain', mediaReferences: [], workReferences: [], potentialScope: 'unknown', seasonNumber: null, episodeIds: null, basis: null, uncertainty: 'title-only' }],
    });
    expect(uncertainContext.activeDownloads[0]).toMatchObject({ uncertainty: 'unknown-association', workReferences: [] });
    expect(JSON.stringify(uncertainContext)).not.toContain('UNKNOWN-PRIVATE');
  });

  it('keeps global open work visible and groups same-title series by service identity, not title', () => {
    const firstEpisode = episode(101, 1, 1, '2020-01-01');
    const secondEpisode = { ...episode(801, 1, 1, '2020-01-01'), seriesId: 8 };
    const inventory = snapshot([firstEpisode]);
    const otherSeries: Series = { ...inventory.sonarr.series[0]!.series, id: 8, tvdbId: 88 };
    inventory.sonarr.series.push({ series: otherSeries, known: true, episodes: [secondEpisode] });
    const first = unit(1, [{ id: 101, number: 1, title: 'Expected one' }]);
    const other: WorkUnit = { ...unit(1, [{ id: 801, number: 1, title: 'Expected other' }]), key: 'sonarr:8:s1', serviceId: 8, externalId: 88 };
    const rows = [reconciled(first, 'ready'), reconciled(other, 'ready')];
    const groups = buildWorkGroups({ snapshot: inventory, rows, now: NOW });
    expect(groups.map((item) => item.key)).toEqual(['sonarr:7', 'sonarr:8']);
    const context = buildPlanningContext({ snapshot: inventory, rows, queues: queues(), intents: [] });
    expect(context.openWork.map((item) => item.workKey)).toEqual(['sonarr:7:s1', 'sonarr:8:s1']);
  });

  it('serializes library target titles as expected descriptions, separates advertised scope, and strips candidate secrets', () => {
    const group = groupFixture();
    const inputCandidate = candidate({ physicalSlot: 2, requested: [{ workKey: 'sonarr:7:s1', episodeIds: [101] }] });
    const pickerPayload = JSON.parse(serializeGroupPickerInput({ group, context: planningContext(), candidates: [inputCandidate] })) as Record<string, unknown>;
    const target = (pickerPayload.targets as Array<Record<string, unknown>>)[0]!;
    expect(JSON.stringify(target)).toContain('expectedEpisodeTitle');
    const releasePayload = ((pickerPayload.candidates as Array<Record<string, unknown>>)[0]!);
    expect(releasePayload).toHaveProperty('observedReleaseTitle');
    expect(releasePayload).toHaveProperty('parsedAdvertisedScope');
    expect(JSON.stringify(releasePayload)).not.toMatch(/guid-|0123456789abcdef|magnet:|https?:|apikey|downloadClientId/);
    const plannerPayload = JSON.parse(serializeGroupPlannerInput({ group, context: planningContext() })) as Record<string, unknown>;
    expect(plannerPayload).toHaveProperty('dueTargetIndices');
  });
});
