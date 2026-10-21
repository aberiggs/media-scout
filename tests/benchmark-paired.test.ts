import { expect, it } from 'vitest';
import { pairedManifest, capturePaired } from '../src/benchmarks/paired';

it('freezes an interleaved exact-query union under equal participant budgets', async () => {
  const q = (query: string) => ({ query, categories: [5000], indexers: ['approved-public'], limit: 200 });
  const manifest = pairedManifest('pilot', [{ model: 'a', prompt: 'v1', requests: [q('Show S01'), q('Show S01E01')] }, { model: 'b', prompt: 'v1', requests: [q('Show S01'), q('Show Season 1')] }]);
  expect(manifest.requests.map(q => q.query)).toEqual(['Show S01', 'Show S01E01', 'Show Season 1']);
  const requests: string[] = [];
  const result = await capturePaired(manifest, false, async request => { requests.push(request.query); return []; });
  expect(result).toEqual([]); expect(requests).toEqual([]);
  const captured = await capturePaired(manifest, true, async request => { requests.push(request.query); return []; });
  expect(captured.map(r => r.availability)).toEqual(['success', 'success', 'success']);
  expect(requests).toEqual(['Show S01', 'Show S01E01', 'Show Season 1']);
  expect(() => pairedManifest('pilot', [{ model: 'a', prompt: 'v1', requests: Array(7).fill(q('Show')) }])).toThrow();
});
