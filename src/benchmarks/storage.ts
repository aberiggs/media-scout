import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatasetSchema, RunSchema, type Dataset, type Run } from './contracts';

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error('invalid artifact identifier');
  return id;
}

export class BenchmarkStorage {
  private readonly datasets: string;
  private readonly runs: string;
  constructor(root: string, private readonly limits: { maxFiles: number; maxBytes: number } = { maxFiles: 100, maxBytes: 100_000_000 }) {
    this.datasets = join(root, 'datasets'); this.runs = join(root, 'runs');
    mkdirSync(this.datasets, { recursive: true, mode: 0o700 }); mkdirSync(this.runs, { recursive: true, mode: 0o700 });
  }
  saveDataset(value: unknown): Dataset {
    const data = DatasetSchema.parse(value); const path = join(this.datasets, `${data.id}-r${data.revision}.json`);
    if (this.exists(path)) throw new Error('dataset revision is immutable');
    this.persist(path, data); return data;
  }
  getDataset(id: string, revision: number): Dataset | null { if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid revision'); const path = join(this.datasets, `${safeId(id)}-r${revision}.json`); return this.exists(path) ? DatasetSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : null; }
  listDatasets(): Dataset[] { return readdirSync(this.datasets).filter((f) => f.endsWith('.json')).map((f) => DatasetSchema.parse(JSON.parse(readFileSync(join(this.datasets, f), 'utf8')))); }
  createRun(value: unknown): Run { const run = RunSchema.parse(value); const path = join(this.runs, `${run.id}.json`); if (this.exists(path)) throw new Error('run already exists'); this.persist(path, run); return run; }
  getRun(id: string): Run | null { const path = join(this.runs, `${safeId(id)}.json`); return this.exists(path) ? RunSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : null; }
  listRuns(): Run[] { return readdirSync(this.runs).filter((f) => f.endsWith('.json')).map((f) => RunSchema.parse(JSON.parse(readFileSync(join(this.runs, f), 'utf8')))); }
  saveRun(value: unknown): Run {
    const run = RunSchema.parse(value); const old = this.getRun(run.id);
    if (!old) throw new Error('run does not exist');
    if (old.datasetId !== run.datasetId || old.datasetRevision !== run.datasetRevision) throw new Error('run lineage is immutable');
    if (old.status !== 'running') throw new Error('invalid run status transition');
    this.persist(join(this.runs, `${run.id}.json`), run); return run;
  }
  recoverInterruptedRuns(): Run[] {
    const updated: Run[] = [];
    for (const file of readdirSync(this.runs).filter((f) => f.endsWith('.json'))) {
      const run = RunSchema.parse(JSON.parse(readFileSync(join(this.runs, file), 'utf8')));
      if (run.status === 'running') updated.push(this.saveRun({ ...run, status: 'interrupted' }));
    }
    return updated;
  }
  private exists(path: string): boolean { try { readFileSync(path); return true; } catch { return false; } }
  private persist(path: string, value: unknown): void {
    const files = [...readdirSync(this.datasets).map((f) => join(this.datasets, f)), ...readdirSync(this.runs).map((f) => join(this.runs, f))];
    const currentSize = files.reduce((sum, f) => sum + readFileSync(f).byteLength, 0);
    const oldSize = this.exists(path) ? readFileSync(path).byteLength : 0;
    const payload = `${JSON.stringify(value)}\n`;
    if (files.length + (oldSize ? 0 : 1) > this.limits.maxFiles || currentSize - oldSize + Buffer.byteLength(payload) > this.limits.maxBytes) throw new Error('benchmark artifact limit exceeded');
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try { writeFileSync(temp, payload, { mode: 0o600, flag: 'wx' }); renameSync(temp, path); } finally { try { unlinkSync(temp); } catch { /* already renamed */ } }
  }
}
