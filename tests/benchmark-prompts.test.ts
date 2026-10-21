import { expect, it } from 'vitest';
import { buildSinglePlannerRequest } from '../src/core/planner';
import { buildSinglePickerRequest } from '../src/core/picker';
import { buildAssociationPrompt } from '../src/core/queue-association';
import type { WorkUnit } from '../src/core/watcher';

const unit: WorkUnit = { key: 'benchmark-movie', kind: 'movie', arr: 'radarr', serviceId: 1, externalId: 42, title: 'Movie', altTitles: ['Alias'], year: 2024 };
it('exposes grounded planner data independently of transport and private service identity', () => {
  const request = buildSinglePlannerRequest(unit);
  expect(JSON.parse(request.user)).toEqual({ kind: 'movie', title: 'Movie', altTitles: ['Alias'], year: 2024, externalId: 42 });
  expect(request.jsonSchema.name).toBe('planner_queries');
});
it('exposes picker and association builders without transporting release links or private lookups', () => {
  const request = buildSinglePickerRequest({ unit, candidates: [] }, 'prefer small');
  expect(JSON.parse(request.user).mediaPreferences).toBe('prefer small');
  const association = buildAssociationPrompt({ promptVersion: 'v1', queue: [], media: [], targets: [] });
  expect(JSON.parse(association.user)).toEqual({ promptVersion: 'v1', queue: [], media: [], targets: [] });
});
