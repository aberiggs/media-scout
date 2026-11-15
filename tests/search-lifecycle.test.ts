import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSearchStore } from '../src/search/store';
import { SearchService } from '../src/search/service';
import { SubmissionService } from '../src/search/submission';
import { ArrAutomation } from '../src/search/automation';
import { ArrObserver } from '../src/search/arr';
import { releaseSchema } from '../src/types/prowlarr';
import type { LLMClient } from '../src/clients/llm';
import type { SonarrQueueRecord } from '../src/types/sonarr';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(twoEpisodes = false) {
  let now = Date.parse('2026-02-01'), clientReads = 0, sourceEnabled = true;
  const directory = mkdtempSync(join(tmpdir(), 'scout-lifecycle-')); directories.push(directory);
  const path = join(directory, 'new.sqlite');
  let store = openSearchStore(path);
  const source = { id: 'server', url: 'http://sonarr', apiKey: 'private-test-key' };
  const episodes = Array.from({ length: twoEpisodes ? 2 : 1 }, (_, i) => ({ id: i + 1, seriesId: 1, seasonNumber: 2, episodeNumber: i + 1, absoluteEpisodeNumber: i + 26, title: `Episode ${i + 1}`, airDate: '2025-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile: false }));
  let queue: SonarrQueueRecord[] = [];
  const grabs: string[] = [];
  const prowlarr = {
    getIndexers: async () => [{ id: 1, name: 'Index', enable: true }], getIndexerStatuses: async () => [],
    search: async () => episodes.flatMap(e => ['popular', 'alternative'].map((variant, i) => releaseSchema.parse({ guid: `${e.id}-${variant}`, indexerId: 1, indexer: 'Index', title: `Example S02E0${e.id} ${variant}`, publishDate: '', protocol: 'torrent', seeders: i ? 50 : 100, downloadUrl: 'http://private/download' }))),
    getDownloadClients: async () => { clientReads++; if (f.changeSourceDuringClientCheck && clientReads === 2) source.url = 'http://replacement'; if (f.removeSourceDuringClientCheck && clientReads === 2) sourceEnabled = false; return [{ id: 7, name: 'TV', enable: true, protocol: 'torrent' as const, supportsCategories: false, categories: [] }]; },
    grab: async (release: { guid: string }) => { grabs.push(release.guid); },
  };
  const llm = { json: async ({ user }: { user: string }) => {
    const input = JSON.parse(user);
    const base = { action: 'finish', query: null, categories: null, indexerIds: null, status: null, options: null, message: null };
    if (!input.candidates.length) return { ...base, action: 'search_releases', query: 'Example' };
    const episode = input.request.context.scope.episodeNumber;
    const candidate = input.candidates.find((c: any) => !c.excluded && c.observations.some((o: any) => o.title.includes(`S02E0${episode}`)));
    return candidate ? { ...base, status: 'matched', options: [{ optionId: 'best', rank: 1, releases: [{ candidateId: candidate.candidateId }], coveredTargetIds: input.request.context.targets.map((t: any) => t.targetId), reason: 'Relevant supported release', uncertainty: '' }] } : { ...base, status: 'no-match' };
  } } as LLMClient;
  function build() {
    const observer = new ArrObserver({ sonarr: { getSeries: async () => [{ id: 1, tvdbId: 20, title: 'Example', titleSlug: 'example', seriesType: 'anime', monitored: true, seasons: [], alternateTitles: [] }], getEpisodes: async () => episodes, getQueue: async () => queue }, source: () => sourceEnabled ? ({ sonarr: source }) : ({}), clock: () => now, store });
    const search = new SearchService({ store, prowlarr, llm, clock: () => now });
    const submission = new SubmissionService({ store, prowlarr, getPolicy: () => ({ dryRun: false, tvClient: 'TV', movieClient: 'TV', queueGraceMinutes: 30 }), clock: () => now });
    return { observer, search, submission, automation: new ArrAutomation({ store, observer, search, submission, getPolicy: () => ({ enabled: true, dryRun: false }), clock: () => now }) };
  }
  const f = { get store() { return store; }, get now() { return now; }, set now(value) { now = value; }, episodes, grabs, changeSourceDuringClientCheck: false, removeSourceDuringClientCheck: false, setQueue(rows: SonarrQueueRecord[]) { queue = rows; }, runtime: build(), restart() { store.close(); store = openSearchStore(path); f.runtime = build(); }, close() { store.close(); } };
  return f;
}

describe('persisted search-first lifecycle', () => {
  it('downloads a missing sibling, observes imports, and reopens a deleted file without local completion authority', async () => {
    const f = fixture(true);
    try {
      await f.runtime.automation.runPass();
      expect(f.grabs).toEqual(['1-popular']);
      f.setQueue([{ seriesId: 1, episodeId: 1, status: 'downloading' }]); f.now += 300_000;
      await f.runtime.automation.runPass();
      expect(f.grabs).toEqual(['1-popular', '2-popular']);
      f.episodes.forEach(e => { e.hasFile = true; }); f.setQueue([]); f.now += 300_000;
      await f.runtime.automation.runPass();
      f.episodes[0]!.hasFile = false; f.now += 1_900_000; f.restart();
      await f.runtime.automation.runPass();
      expect(f.grabs).toEqual(['1-popular', '2-popular', '1-popular']);
    } finally { f.close(); }
  });
  it('survives restart and tries a different release after unmatched appearance grace', async () => {
    const f = fixture();
    try {
      await f.runtime.automation.runPass();
      f.now += 300_000; f.restart();
      expect((await f.runtime.automation.runPass()).reason).toBe('nothing-due');
      f.now += 1_600_000;
      await f.runtime.automation.runPass();
      expect(f.grabs).toEqual(['1-popular', '1-alternative']);
      expect(JSON.stringify(f.store.listSearches())).not.toContain('http://private');
    } finally { f.close(); }
  });
  it.each(['changed', 'removed'])('checks the CURRENT %s source after async client validation, not a captured constant', async mode => {
    const f = fixture(); f.changeSourceDuringClientCheck = mode === 'changed'; f.removeSourceDuringClientCheck = mode === 'removed';
    try {
      const pass = await f.runtime.automation.runPass();
      expect(pass.submission?.outcome).toBe('failed');
      expect(f.grabs).toEqual([]);
    } finally { f.close(); }
  });
});
