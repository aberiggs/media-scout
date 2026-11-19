import { OpenRouter } from '@openrouter/sdk';
import Database from 'better-sqlite3';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { OpenRouterLLM, type LLMClient } from '../src/clients/llm';
import { ProwlarrClient } from '../src/clients/prowlarr';
import { Http } from '../src/http';
import { releaseSchema, type Release } from '../src/types/prowlarr';
import { SearchService, safeText } from '../src/search/service';
import { openSearchStore } from '../src/search/store';
import { settingsSchema, type Settings } from '../src/search/settings';
import type { SearchRequest } from '../src/search/contracts';

type CaseName = 'rezero' | 'kaiju';
type IndexerMode = 'real-indexers' | 'fixture-indexers';
interface Args { db: string; out: string; case: CaseName; mode: IndexerMode }

function args(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) throw new Error('Expected --db, --out, --case, and --mode values.');
    values.set(argv[i]!, argv[i + 1]!);
  }
  const db = values.get('--db'), out = values.get('--out'), show = values.get('--case'), mode = values.get('--mode');
  if (!db || !out || (show !== 'rezero' && show !== 'kaiju') || (mode !== 'real-indexers' && mode !== 'fixture-indexers'))
    throw new Error('Usage: --db <settings.sqlite> --out <outside-repo-dir> --case rezero|kaiju --mode real-indexers|fixture-indexers');
  return { db: resolve(db), out: resolve(out), case: show, mode };
}

function readSettings(path: string): Settings {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT value_json FROM settings WHERE key='application-settings'").get() as { value_json: string } | undefined;
    if (!row) throw new Error('Saved application settings were not found.');
    return settingsSchema.parse(JSON.parse(row.value_json));
  } finally { db.close(); }
}

export function syntheticRequest(show: CaseName): SearchRequest {
  const rezero = show === 'rezero';
  const title = rezero ? 'Re:Zero − Starting Life in Another World' : 'Kaiju No. 8';
  const total = rezero ? 85 : 23;
  return {
    prompt: `Find useful releases covering the requested missing episodes of ${title}. Prefer healthy 1080p Japanese audio with English or multi-sub. Metadata may collect multiple release seasons into one season. Explore the release naming, aliases and packs; use the supplied absolute numbers and available evidence to infer reasonable coverage, explaining uncertainty. Incidental related episodes in useful packs are acceptable. Useful partial progress is welcome.`,
    context: {
      kind: 'tv', titles: rezero ? [title, 'Re Zero kara Hajimeru Isekai Seikatsu'] : [title, 'Kaijuu 8-gou'], seriesType: 'anime', scope: { type: 'episode-set' },
      targets: Array.from({ length: total }, (_, i) => ({
        targetId: `synthetic-${show}-${i + 1}`, seasonNumber: 1, episodeNumber: i + 1,
        absoluteEpisodeNumber: i + 1,
      })),
      relatedEpisodes: [
        { episodeRef: 'synthetic-future', seasonNumber: 1, episodeNumber: total + 1, hasFile: false, queued: false, monitored: true, available: false, contextReason: 'not-yet-available' },
        { episodeRef: 'synthetic-owned-special', seasonNumber: 0, episodeNumber: 1, hasFile: true, queued: false, monitored: true, available: true, contextReason: 'already-owned' },
        { episodeRef: 'synthetic-queued-special', seasonNumber: 0, episodeNumber: 2, hasFile: false, queued: true, monitored: true, available: true, contextReason: 'observed-in-queue' },
      ],
    },
  };
}

function fixtureReleases(show: CaseName): Release[] {
  const title = show === 'rezero' ? 'Re Zero Starting Life in Another World' : 'Kaiju No. 8';
  const seasons = show === 'rezero' ? [1, 2, 3, 4] : [1, 2];
  const packs = seasons.map(season => releaseSchema.parse({
    guid: `fixture-${show}-s${season}`, indexerId: 1, indexer: 'Fixture Indexer',
    title: `${title} S${String(season).padStart(2, '0')} 1080p BluRay`, publishDate: '',
    protocol: 'torrent', seeders: 20, categories: [{ id: 5000, name: 'TV' }], downloadUrl: `http://fixture.invalid/${show}/${season}`,
  }));
  return [
    ...packs,
    releaseSchema.parse({ guid: `${show}-numeric-range`, indexerId: 1, indexer: 'Fixture Indexer', title: `${title} 078-085 1080p numeric range pack`, publishDate: '', protocol: 'torrent', categories: [{ id: 5000, name: 'TV' }], downloadUrl: 'http://fixture.invalid/numeric-range' }),
    releaseSchema.parse({ guid: `${show}-special`, indexerId: 1, indexer: 'Fixture Indexer', title: `${title} Recap Special 1080p`, publishDate: '', protocol: 'torrent', categories: [{ id: 5000, name: 'TV' }], downloadUrl: 'http://fixture.invalid/special' }),
    releaseSchema.parse({ guid: `${show}-manga`, indexerId: 2, indexer: 'Fixture Indexer', title: `${title} manga volume scan`, publishDate: '', protocol: 'usenet', categories: [{ id: 7000, name: 'Books' }], downloadUrl: 'http://fixture.invalid/manga' }),
  ];
}

export function safe(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /apikey|token|authorization|password|secret/i.test(k) ? '[redacted]' : safe(v)]));
  return value;
}

export function searchFixtureReleases(show: CaseName, params: Parameters<ProwlarrClient['search']>[0]): Release[] {
  return fixtureReleases(show).filter(release =>
    (params.indexerIds === undefined || params.indexerIds.includes(release.indexerId)) &&
    (!params.categories.length || release.categories.some(category => params.categories.some(id => id === category.id || id % 1000 === 0 && Math.floor(category.id / 1000) * 1000 === id))) &&
    params.query.toLocaleLowerCase().split(/\s+/u).some(word => word.length > 2 && release.title.toLocaleLowerCase().includes(word)));
}

export function evaluationOutputDirectory(out: string, repository: string): string {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(out);
  const fromRepository = relative(realpathSync(repository), canonical);
  if (fromRepository === '' || (fromRepository !== '..' && !fromRepository.startsWith(`..${sep}`) && !isAbsolute(fromRepository)))
    throw new Error('Output directory must be outside the repository.');
  return canonical;
}

async function main(): Promise<void> {
  const cli = args(process.argv.slice(2));
  cli.out = evaluationOutputDirectory(cli.out, fileURLToPath(new URL('..', import.meta.url)));
  const settings = readSettings(cli.db);
  if (!settings.ai.apiKey || !settings.ai.model || !settings.integrations.prowlarr.url || !settings.integrations.prowlarr.apiKey)
    throw new Error('Saved model and Prowlarr settings must be configured.');
  mkdirSync(cli.out, { recursive: true });
  const runId = `${cli.case}-${cli.mode}-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const path = resolve(cli.out, `${runId}.json`);
  const report: Record<string, unknown> = {
    runId, case: cli.case, mode: cli.mode, synthetic: true, note: 'Synthetic collapsed-season fixture; not Sonarr/TMDB data or factual episode correspondence.',
    model: settings.ai.model, limits: { decisions: 40, searches: 30, deadlineMs: 1_800_000, llmTimeoutMs: 600_000, prowlarrTimeoutMs: 600_000 },
    decisions: [], result: null,
    validation: 'SearchService validates every model action schema and validates selected target/identity assignments.',
  };
  const decisions = report.decisions as Array<Record<string, unknown>>;
  const upstreamCalls = report.upstreamCalls = [] as Array<Record<string, unknown>>;
  const totalStarted = performance.now();
  const timed = async <T>(boundary: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      const result = await run();
      upstreamCalls.push({ boundary, elapsedMs: Math.round(performance.now() - started), outcome: 'ok' });
      return result;
    } catch (error) {
      upstreamCalls.push({ boundary, elapsedMs: Math.round(performance.now() - started), outcome: 'error', error: error instanceof Error ? error.name : 'Error' });
      throw error;
    }
  };
  let store: ReturnType<typeof openSearchStore> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Evaluation cancelled by signal.'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const client = new OpenRouter({ apiKey: settings.ai.apiKey, serverURL: settings.ai.baseUrl });
    const rawModel = new OpenRouterLLM({ client, model: settings.ai.model });
    const llm: LLMClient = { json: async request => {
      const started = performance.now();
      const input = { system: safe(request.system), user: safe(JSON.parse(request.user)) };
      try {
        const output = await rawModel.json(request);
        decisions.push({ elapsedMs: Math.round(performance.now() - started), schemaValidated: true, input, output: safe(output) });
        return output;
      } catch (error) {
        decisions.push({ elapsedMs: Math.round(performance.now() - started), input, error: error instanceof Error ? { name: error.name, message: safeText(error.message) } : { name: 'Error' } });
        throw error;
      }
    } };
    const real = new ProwlarrClient(new Http({ baseUrl: settings.integrations.prowlarr.url, apiKey: settings.integrations.prowlarr.apiKey, timeoutMs: 600_000 }));
    const baseProwlarr: Pick<ProwlarrClient, 'getIndexers' | 'getIndexerStatuses' | 'search'> = cli.mode === 'real-indexers' ? real : {
      getIndexers: async () => [{ id: 1, name: 'Fixture Indexer', enable: true }, { id: 2, name: 'Fixture Secondary', enable: true }],
      getIndexerStatuses: async () => [],
      search: async (params: Parameters<ProwlarrClient['search']>[0]) => searchFixtureReleases(cli.case, params),
    } as any;
    const prowlarr = {
      getIndexers: () => timed('prowlarr.indexers', () => baseProwlarr.getIndexers()),
      getIndexerStatuses: () => timed('prowlarr.statuses', () => baseProwlarr.getIndexerStatuses()),
      search: (params: Parameters<typeof baseProwlarr.search>[0], options?: Parameters<typeof baseProwlarr.search>[1]) =>
        timed(`prowlarr.search:${safeText(params.query)}`, () => baseProwlarr.search(params, options)),
    };
    store = openSearchStore(':memory:');
    const searchId = `evaluation-${runId}`, request = syntheticRequest(cli.case), now = Date.now();
    store.enqueueSearch({ searchId, prompt: JSON.stringify(request), now, source: 'manual', context: {} });
    const owner = `evaluation-owner-${runId}`;
    const work = store.claimNextSearch(owner, now, 2_700_000, 1);
    if (!work) throw new Error('Could not claim harness search job.');
    const service = new SearchService({
      llm, prowlarr, store,
      limits: { decisions: 40, searches: 30, deadlineMs: 1_800_000, llmTimeoutMs: 600_000, prowlarrTimeoutMs: 600_000 },
    });
    const result = await service.run(request, {}, controller.signal, {}, searchId, owner);
    const candidateNames = new Map(result.candidates.map(c => [c.candidateId, c.observations.map(o => o.title)]));
    report.result = safe({
      status: result.status, message: result.message, promptVersion: result.promptVersion, counts: result.counts,
      queries: result.events.filter(e => e.type === 'query-start' || e.type === 'query-result' || e.type === 'query-repeat'),
      options: result.options.map(option => ({
        optionId: option.optionId, releases: option.releases.map(release => ({
          candidateId: release.candidateId, titles: candidateNames.get(release.candidateId) ?? [],
          coveredTargetIds: 'coveredTargetIds' in release ? release.coveredTargetIds : [],
          coverageReason: 'coverageReason' in release ? release.coverageReason : undefined,
          uncertainty: 'uncertainty' in release ? release.uncertainty : undefined,
        })),
        coveredTargetIds: option.coveredTargetIds, uncoveredTargetIds: 'uncoveredTargetIds' in option ? option.uncoveredTargetIds : [],
      })),
    });
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    store?.close();
    report.elapsedMs = Math.round(performance.now() - totalStarted);
    writeFileSync(path, `${JSON.stringify(safe(report), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.info(`Evaluation artifact: ${path}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Search-only evaluation failed. Inspect the secured output artifact if it was written.');
    process.exitCode = 1;
  });
}
