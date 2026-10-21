import { expect, it } from 'vitest';
import { serverBenchmarkProfiles } from '../src/benchmarks/profiles';

it('registers experimental hosted model choices without overwriting configured settings', () => {
  const ai = { model: 'configured/model', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'canary' };
  const profiles = serverBenchmarkProfiles(ai, { BENCHMARK_MODELS: 'other/model,third/model' });
  expect(profiles.map(p => p.model)).toEqual(['configured/model', 'other/model', 'third/model']);
  expect(ai.model).toBe('configured/model');
});
