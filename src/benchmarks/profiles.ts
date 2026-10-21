import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ModelProfile } from './service';

const Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/._:+-]{0,149}$/);
const Profile = z.object({ id: z.string().regex(/^[\w.-]{1,100}$/), label: z.string().max(100).regex(/^[\w .()/-]+$/), model: Name, baseUrl: z.string().url(), apiKey: z.string().default('benchmark-local'),
  local: z.object({ contextTokens: z.number().int().min(1024).max(4_000_000), structuredOutput: z.literal(true), seedSupported: z.boolean().default(false) }).strict().optional(),
}).strict();

/** Operator-owned server configuration, never browser-supplied destinations. */
export function serverBenchmarkProfiles(ai: { model: string; baseUrl: string; apiKey: string }, env: Record<string, string | undefined> = process.env): ModelProfile[] {
  const models = [...new Set([ai.model, ...(env.BENCHMARK_MODELS ?? '').split(',').map(m => m.trim()).filter(Boolean)])];
  const profiles: ModelProfile[] = models.map((model, i) => ({ id: i === 0 ? 'configured' : `hosted-${i}`, label: i === 0 ? 'Configured model (isolated snapshot)' : 'Registered experimental hosted model', model: Name.parse(model), baseUrl: ai.baseUrl, apiKey: ai.apiKey }));
  if (env.BENCHMARK_PROFILES_FILE) {
    const text = readFileSync(env.BENCHMARK_PROFILES_FILE, 'utf8');
    if (Buffer.byteLength(text) > 64000) throw new Error('profile configuration exceeds limit');
    for (const p of Profile.array().max(10).parse(JSON.parse(text))) {
      const url = new URL(p.baseUrl);
      if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('invalid profile endpoint');
      if (p.local && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('unknown-price local profiles require a loopback endpoint');
      profiles.push(p);
    }
  }
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('duplicate profile identifier');
  return profiles;
}
