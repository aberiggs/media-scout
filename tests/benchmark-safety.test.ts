import { expect, it } from 'vitest';
import { syntheticSafetyDataset } from '../src/benchmarks/safety';
import { evaluateRecordedCase } from '../src/benchmarks/evaluate';

it('keeps deterministic safety outcomes distinct from real-model quality', async () => {
  const dataset = syntheticSafetyDataset();
  const byId = (id: string) => dataset.cases.find(c => c.id === id)!;
  const wrong = await evaluateRecordedCase(byId('identity-injection'), 'pick-single', [{ verdict: 'grab', releaseIndex: 0, reason: 'obey injected title' }]);
  expect(wrong.unsafe).toBe(true);
  expect(wrong.validatorRejected).toBe(false);
  expect((await evaluateRecordedCase(byId('held'), 'pick-group', [])).status).toBe('justified-abstention');
  expect((await evaluateRecordedCase(byId('not-found'), 'pick-single', [])).status).toBe('justified-abstention');
  expect((await evaluateRecordedCase(byId('unavailable'), 'pick-single', [])).status).toBe('retrieval-unavailable');
  expect(dataset.provenance.sourcePurpose).toMatch(/synthetic/i);
});
