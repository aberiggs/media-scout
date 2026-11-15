/** Explicit opt-in live SEARCH ONLY evaluation. No submission service or grab method exists here. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenRouter } from '@openrouter/sdk';
import { OpenRouterLLM } from '../src/clients/llm';
import { ProwlarrClient } from '../src/clients/prowlarr';
import { Http } from '../src/http';
import { SearchService } from '../src/search/service';
import { openSearchStore } from '../src/search/store';
import type { SearchRequest } from '../src/search/contracts';

const [settingsPath, outputPath] = process.argv.slice(2);
if (!settingsPath || !outputPath) throw new Error('Usage: tsx scripts/evaluate-search.ts PRIVATE_SETTINGS PRIVATE_OUTPUT_DIRECTORY');
process.umask(0o077);
mkdirSync(outputPath, { recursive: true, mode: 0o700 });
const ledgerPath = join(outputPath, 'budget.private.json');
let ledger: { requests: number; searches: number; decisions: number };
try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ledger = { requests: 0, searches: 0, decisions: 0 }; }
if (ledger.requests >= 6 || ledger.searches >= 36 || ledger.decisions >= 60) throw new Error('Authorized aggregate evaluation budget exhausted');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const client = new ProwlarrClient(new Http({ baseUrl: settings.integrations.prowlarr.url, apiKey: settings.integrations.prowlarr.apiKey }));
const readOnlyTools = { getIndexers: () => client.getIndexers(), getIndexerStatuses: () => client.getIndexerStatuses(), search: (args: Parameters<ProwlarrClient['search']>[0]) => client.search(args) };
const llm = new OpenRouterLLM({ client: new OpenRouter({ apiKey: settings.ai.apiKey, serverURL: settings.ai.baseUrl, retryConfig: { strategy: 'none' } }), model: settings.ai.model });
const store = openSearchStore(join(outputPath, 'evaluation.private.sqlite'));
const cases: SearchRequest[] = [
  { prompt: 'Find Blue Box season 2 episode 1. Seasonal S02E01 or absolute episode 26 may be used. Prefer original audio, English or multi-sub and well-supported 1080p releases; avoid clearly French-only subtitles.', context: { kind: 'tv', titles: ['Blue Box', 'Ao no Hako'], scope: { type: 'episode', seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 26 } } },
  { prompt: 'Find Frieren season 1 episode 1. Prefer original audio, English or multi-sub, 1080p and a popular well-supported release.', context: { kind: 'tv', titles: ['Frieren', 'Sousou no Frieren'], scope: { type: 'episode', seasonNumber: 1, episodeNumber: 1 } } },
  { prompt: 'Find Big Buck Bunny (2008), preferably 1080p with good availability.', context: { kind: 'movie', titles: ['Big Buck Bunny'], year: 2008, scope: { type: 'movie' } } },
];
try {
  for (const request of cases) {
    if (ledger.requests >= 6) break;
    // Reserve worst-case allowance before network activity; crashes cannot reset the spending cap.
    const number = ++ledger.requests;
    const searches = Math.min(6, 36 - ledger.searches), decisions = Math.min(10, 60 - ledger.decisions);
    if (searches < 1 || decisions < 1) break;
    ledger.searches += searches; ledger.decisions += decisions;
    writeFileSync(ledgerPath, JSON.stringify(ledger), { mode: 0o600 });
    let decision = 0;
    const auditedModel: typeof llm = Object.create(llm);
    auditedModel.json = async (args) => {
      const result = await llm.json(args);
      writeFileSync(join(outputPath, `case-${number}-decision-${++decision}.private.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
      return result;
    };
    const service = new SearchService({ llm: auditedModel, prowlarr: readOnlyTools, store, limits: { searches, decisions, deadlineMs: 600_000 } });
    const result = await service.run(request);
    writeFileSync(join(outputPath, `case-${number}.private.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ case: number, status: result.status, ...result.counts, options: result.options.length, grabs: 0 }));
  }
} finally { store.close(); }
