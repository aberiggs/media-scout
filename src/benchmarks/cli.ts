/** Explicit model-only CLI. Receives ONLY selected AI connection fields on stdin. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { BenchmarkService, bundledBenchmarkDataset, summarizeRun } from './service';
import { benchmarkTracks } from './evaluate';

async function main() {
  const { values } = parseArgs({ options: { execute: { type: 'boolean', default: false }, 'approve-disclosure': { type: 'boolean', default: false }, root: { type: 'string' }, 'max-dollars': { type: 'string' }, 'request-id': { type: 'string' }, tracks: { type: 'string' }, 'max-output-tokens': { type: 'string', default: '8192' }, 'max-seconds': { type: 'string', default: '1800' } } });
  if (!values.execute || !values['approve-disclosure'] || !values.root || !values['max-dollars'] || !values['request-id']) throw new Error('explicit execution, disclosure, artifact root, request ID and spending cap required');
  const input = readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 16000) throw new Error('connection input exceeds limit');
  const connection = z.object({ apiKey: z.string().min(1), baseUrl: z.string().url(), model: z.string().min(1) }).strict().parse(JSON.parse(input));
  const dataset = bundledBenchmarkDataset();
  const service = new BenchmarkService({ root: values.root, datasets: [dataset], profiles: () => [{ id: 'configured', label: 'Configured model', ...connection }] });
  const run = await service.start({ requestId: values['request-id'], datasetId: dataset.id, datasetRevision: dataset.revision, profileId: 'configured', model: connection.model,
    prompt: 'production-v1', tracks: values.tracks ? values.tracks.split(',') : benchmarkTracks, split: 'all', repeats: 1,
    maxAttempts: 240, maxTokens: 300_000_000, maxOutputTokens: Number(values['max-output-tokens']), maxSeconds: Number(values['max-seconds']), maxDollars: Number(values['max-dollars']), disclosureApproved: true, temperature: 0, seed: null });
  console.log(JSON.stringify({ id: run.id, status: run.status, plannedCases: run.plannedCases, maxDollars: run.config?.maxDollars, model: run.config?.model, priceBound: run.priceBound }));
  const stop = () => { service.cancel(run.id); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const timer = setInterval(() => { const current = service.get(run.id); if (current) console.log(JSON.stringify({ id: current.id, status: current.status, ...summarizeRun(current) })); }, 30_000);
  try { await service.settled(); }
  finally { clearInterval(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  const final = service.get(run.id)!;
  console.log(JSON.stringify({ id: final.id, status: final.status, stopReason: final.stopReason, ...summarizeRun(final) }));
  if (final.status !== 'completed') process.exitCode = 2;
}
main().catch(() => { console.error('benchmark execution unavailable; no private provider error is printed'); process.exitCode = 1; });
