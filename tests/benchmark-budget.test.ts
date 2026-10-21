import { expect, it } from 'vitest';
import { AttemptBudget } from '../src/benchmarks/budget';

it('rejects missing hard-dollar bounds and nonfinite or negative limits', () => {
  expect(() => new AttemptBudget({ calls: 1, tokens: 100, cost: -1 })).toThrow();
  const budget = new AttemptBudget({ calls: 2, tokens: 10000, cost: 2 });
  expect(() => budget.reserve({ maxOutputTokens: 64, inputCostPerToken: NaN, outputCostPerToken: 1 }, ['s'])).toThrow();
  expect(() => budget.reserve({ maxOutputTokens: 64, inputCostPerToken: 0.000001, outputCostPerToken: 0.000001 }, ['s'])).toThrow();
});
it('invalidates the allowance if observed cost contradicts the reserved bound', () => {
  const budget = new AttemptBudget({ calls: 5, tokens: 100000, cost: 2 });
  const bound = { maxOutputTokens: 10, inputTokens: 100, inputCostPerToken: 0.001, outputCostPerToken: 0.001 };
  const r = budget.reserve(bound, []);
  budget.settle(r, 2);
  expect(() => budget.reserve(bound, [])).toThrow();
  expect(budget.snapshot().knownActualCost).toBe(2);
});
it('reserves every retry, retains unknown costs and never exceeds the ceiling', () => {
  const budget = new AttemptBudget({ calls: 3, tokens: 100000, cost: 2 });
  const bound = { maxOutputTokens: 100, inputTokens: 1000, inputCostPerToken: 0.001, outputCostPerToken: 0.001 };
  const first = budget.reserve(bound, []);
  budget.settle(first, null);
  expect(() => budget.reserve(bound, [])).toThrow(/allowance/i);
  expect(budget.snapshot().knownActualCost).toBe(0);
  expect(budget.snapshot().reserved.cost).toBeCloseTo(1.1);
});
it('does not let duplicate settlement refund the same reservation twice', () => {
  const budget = new AttemptBudget({ calls: 5, tokens: 100000, cost: 2 });
  const bound = { maxOutputTokens: 100, inputTokens: 1000, inputCostPerToken: 0.001, outputCostPerToken: 0.001 };
  const r = budget.reserve(bound, []);
  budget.settle(r, 0.1);
  expect(() => budget.settle(r, 0.1)).toThrow();
});
