/** Loopback-only synthetic UI fixture. No real credentials, models, indexers or downloads. */
import { buildStack } from '../src/compose';
import { loadConfig } from '../src/config';
import { buildApp } from '../src/daemon';
import { defaultSettings } from '../src/search/settings';
import type { LLMClient } from '../src/clients/llm';
import { releaseSchema } from '../src/types/prowlarr';

const settings = structuredClone(defaultSettings);
settings.integrations.prowlarr = { url: 'http://synthetic.invalid', apiKey: 'preview-only', tvClient: 'TV category', movieClient: 'Movie category' };
settings.integrations.sonarr = { url: 'http://synthetic.invalid', apiKey: 'preview-only' };
settings.ai.apiKey = 'preview-only'; settings.ai.model = 'synthetic-preview-no-provider-calls';
const llm = { json: async ({ user }: {user: string}) => {
  const input = JSON.parse(user), empty = { action: 'finish', query: null, categories: null, indexerIds: null, status: null, options: null, message: null };
  if (!input.candidates.length) return { ...empty, action: 'search_releases', query: 'Signal Harbor S02E01', categories: [5000] };
  return { ...empty, status: 'matched', options: input.candidates.slice(0, 2).map((candidate: {candidateId:string}, index: number) => ({ optionId: `option-${index}`, rank: index + 1, releases: [{ candidateId: candidate.candidateId }], coveredTargetIds: input.request.context?.targets?.map((t:{targetId:string}) => t.targetId) ?? [], reason: index ? 'A smaller release with less availability.' : 'A well-supported 1080p multi-sub release matching the requested episode.', uncertainty: 'Synthetic preview: torrent contents are not inspected.' })) };
} } as LLMClient;
const stack = buildStack({ config: loadConfig({ DB_PATH: ':memory:', HTTP_PORT: '4787', HTTP_HOST: '127.0.0.1', LOG_LEVEL: 'silent' }), initialSettings: settings, llm, clients: () => ({
  prowlarr: {
    getIndexers: async () => [{ id: 1, name: 'Synthetic preview', enable: true }], getIndexerStatuses: async () => [],
    search: async () => [180, 40].map((seeders, index) => releaseSchema.parse({ guid: `synthetic-${index}`, indexerId: 1, indexer: 'Synthetic preview only', title: `Signal Harbor S02E01 ${index ? '720p' : '1080p MULTI-SUB'} WEB`, seeders, size: index ? 600_000_000 : 1_300_000_000, publishDate: '', protocol: 'torrent' })),
    getDownloadClients: async () => [{ id: 1, name: 'TV category', enable: true, protocol: 'torrent', supportsCategories: true, categories: [] }, { id: 2, name: 'Movie category', enable: true, protocol: 'torrent', supportsCategories: true, categories: [] }],
    grab: async () => { throw new Error('Preview forbids all downloads'); },
  },
  sonarr: {
    getSeries: async () => [{ id: 1, tvdbId: 1, title: 'Signal Harbor', titleSlug: 'signal-harbor', seriesType: 'standard', monitored: true, seasons: [], alternateTitles: [] }],
    getEpisodes: async () => [1, 2, 3].map(number => ({ id: number, seriesId: 1, seasonNumber: 2, episodeNumber: number, absoluteEpisodeNumber: null, title: `Episode ${number}`, airDate: number === 3 ? '2030-01-01' : '2026-01-01', airDateUtc: null, finaleType: null, monitored: true, hasFile: false })),
    getQueue: async () => [{ seriesId: 1, episodeId: 2, status: 'downloading' }],
  },
}) });
await stack.runtime.poll();
const app = await buildApp(stack);
await app.listen({ port: 4787, host: '127.0.0.1' });
console.log('Synthetic preview only: http://127.0.0.1:4787 (no live calls or downloads)');
const stop = () => { void app.close().then(() => stack.runtime.close()); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
