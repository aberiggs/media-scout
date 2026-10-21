import type { FastifyInstance, FastifyRequest, FastifyBaseLogger, RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { BenchmarkService, summarizeRun } from './service';

const Page = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict();
const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export function registerBenchmarkRoutes<L extends FastifyBaseLogger>(app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, L>, service: BenchmarkService, mutationAllowed: (request: FastifyRequest) => boolean): void {
  app.get('/api/benchmarks', async () => service.catalog());
  app.get<{ Params: { id: string; revision: string; caseId: string } }>('/api/benchmarks/datasets/:id/revisions/:revision/cases/:caseId', async (request, reply) => {
    const { id, revision, caseId } = request.params;
    if (!Id.safeParse(id).success || !Id.safeParse(caseId).success || !/^[1-9]\d{0,5}$/.test(revision)) return reply.code(400).send({ error: 'invalid evidence request' });
    const evidence = service.evidence(id, Number(revision), caseId);
    return evidence ?? reply.code(404).send({ error: 'evidence not found' });
  });
  app.get('/api/benchmarks/runs', async (request, reply) => {
    const page = Page.safeParse(request.query);
    if (!page.success) return reply.code(400).send({ error: 'invalid pagination' });
    const runs = service.list();
    return { total: runs.length, ...page.data, runs: runs.slice(page.data.offset, page.data.offset + page.data.limit).map(({ results: _results, attempts: _attempts, ...run }) => ({ ...run, summary: summarizeRun(service.get(run.id)!) })) };
  });
  app.post('/api/benchmarks/runs', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected' });
    try { return reply.code(202).send(await service.start(request.body)); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid benchmark configuration' });
      const conflict = error instanceof Error && /active|idempotency/.test(error.message);
      return reply.code(conflict ? 409 : 400).send({ error: conflict ? 'benchmark active or duplicate request conflict' : 'benchmark unavailable; check reviewed dataset, profile, capabilities and conservative spending bounds' });
    }
  });
  app.get<{ Params: { id: string } }>('/api/benchmarks/runs/:id', async (request, reply) => {
    const page = Page.safeParse(request.query);
    if (!page.success || !Id.safeParse(request.params.id).success) return reply.code(400).send({ error: 'invalid query' });
    const run = service.get(request.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const { results = [], attempts, ...snapshot } = run;
    return { run: { ...snapshot, results: results.slice(page.data.offset, page.data.offset + page.data.limit), attempts: attempts.slice(page.data.offset, page.data.offset + page.data.limit) }, summary: summarizeRun(run), totalResults: results.length, totalAttempts: attempts.length, ...page.data };
  });
  app.post<{ Params: { id: string } }>('/api/benchmarks/runs/:id/cancel', async (request, reply) => {
    if (!mutationAllowed(request)) return reply.code(403).send({ error: 'cross-origin mutation rejected' });
    if (!Id.safeParse(request.params.id).success) return reply.code(400).send({ error: 'invalid run' });
    const run = service.cancel(request.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return { id: run.id, status: run.status, cancelRequested: run.cancelRequested };
  });
  app.get<{ Params: { id: string } }>('/api/benchmarks/runs/:id/export', async (request, reply) => {
    if (!Id.safeParse(request.params.id).success) return reply.code(400).send({ error: 'invalid run' });
    const run = service.get(request.params.id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return reply.header('Content-Disposition', `attachment; filename="benchmark-${run.id}.json"`).send({ run, summary: summarizeRun(run) });
  });
  app.addHook('onClose', async () => { for (const run of service.list()) if (run.status === 'running') service.cancel(run.id); await service.settled(); });
}
