import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CandidateSchema, DatasetCaseSchema } from './contracts';

const Request = DatasetCaseSchema.shape.queries.element.pick({ query: true, categories: true, indexers: true, limit: true }).extend({ categories: z.array(z.number().int()).min(1).max(4), indexers: z.array(z.string().regex(/^[\w.-]+$/)).min(1).max(2), limit: z.number().int().min(1).max(200) });
type Request = z.infer<typeof Request>;
const Participants = z.array(z.object({ model: z.string().regex(/^[\w/.:+-]{1,150}$/), prompt: z.string().regex(/^[\w.-]{1,100}$/), requests: z.array(Request).min(1).max(6) }).strict()).min(1).max(12);
const key = (q: Request) => JSON.stringify([q.query, [...q.categories].sort(), [...q.indexers].sort(), q.limit]);
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

/** Freeze all model/prompt queries BEFORE showing any retrieval to participants. */
export function pairedManifest(dataset: string, value: unknown) {
  z.string().regex(/^[\w.-]{1,128}$/).parse(dataset);
  const participants = Participants.parse(value), requests: Request[] = [], seen = new Set<string>();
  for (let round = 0; round < 6; round++) for (const p of participants) {
    const q = p.requests[round]; if (!q || seen.has(key(q))) continue;
    requests.push(q); seen.add(key(q));
  }
  const manifest = { schemaVersion: 1, dataset, participants, requests, maxRequests: 72, maxRows: 10000, maxSeconds: 1800, adaptive: false };
  return freeze({ ...manifest, hash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') });
}

/** Explicit capability seam for separately approved read-only captures. No route
 * or model run invokes it. Supply the capture tool's scoped/sanitizing search
 * adapter, never the production Prowlarr client (which also exposes grab).
 */
export async function capturePaired(manifest: ReturnType<typeof pairedManifest>, approved: boolean, search: (request: Request, signal: AbortSignal) => Promise<unknown>, controls = { now: Date.now, pause: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }) {
  if (!approved) return [];
  const validated = pairedManifest(manifest.dataset, manifest.participants);
  if (validated.hash !== manifest.hash) throw new Error('paired manifest changed');
  manifest = validated;
  const records: Array<{ request: Request; availability: 'success' | 'unavailable'; candidates: z.infer<typeof CandidateSchema>[]; truncated: boolean; completeness: 'upstream-completeness-unknown' }> = [];
  const deadline = controls.now() + manifest.maxSeconds * 1000;
  let rows = 0, stopped = false;
  for (const [index, request] of manifest.requests.entries()) {
    if (index > 0 && !stopped) await controls.pause(1000);
    if (controls.now() >= deadline || rows >= manifest.maxRows || index >= manifest.maxRequests) stopped = true;
    if (stopped) { records.push({ request, availability: 'unavailable', candidates: [], truncated: false, completeness: 'upstream-completeness-unknown' }); continue; }
    try {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('capture deadline')); }, Math.min(30000, Math.max(1, deadline - controls.now()))); });
      let response: unknown;
      try { response = await Promise.race([search(request, controller.signal), timeout]); }
      finally { if (timer) clearTimeout(timer); }
      if (controls.now() >= deadline) throw new Error('capture deadline');
      const candidates = CandidateSchema.array().max(200).parse(response);
      const remaining = manifest.maxRows - rows;
      const retained = candidates.slice(0, remaining); rows += retained.length;
      records.push({ request, availability: 'success', candidates: retained, truncated: retained.length < candidates.length, completeness: 'upstream-completeness-unknown' });
    } catch { stopped = true; records.push({ request, availability: 'unavailable', candidates: [], truncated: false, completeness: 'upstream-completeness-unknown' }); }
  }
  return records;
}
