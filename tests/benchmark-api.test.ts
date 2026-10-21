import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBenchmarkRoutes } from '../src/benchmarks/routes';
import { BenchmarkService, bundledBenchmarkDataset } from '../src/benchmarks/service';

it('rejects cross-origin launch/cancel and never exposes endpoint credentials in catalog or errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-api-'));
  const app = Fastify();
  try {
    registerBenchmarkRoutes(app, new BenchmarkService({ root, datasets: [bundledBenchmarkDataset()], profiles: () => [{ id: 'configured', label: 'Configured', model: 'test', baseUrl: 'https://private.invalid', apiKey: 'canary-secret' }] }), () => false);
    expect((await app.inject({ method: 'POST', url: '/api/benchmarks/runs', payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/benchmarks/runs/a/cancel' })).statusCode).toBe(403);
    const catalog = await app.inject('/api/benchmarks');
    expect(catalog.statusCode).toBe(200);
    expect(catalog.body).not.toMatch(/canary-secret|private.invalid/);
    expect((await app.inject('/api/benchmarks/runs?limit=9999')).statusCode).toBe(400);
    expect((await app.inject('/api/benchmarks/runs/missing')).statusCode).toBe(404);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
