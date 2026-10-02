import { describe, expect, it } from 'vitest';
import {
  associationResponseJsonSchema,
  associationResponseSchema,
  groupPlanEnvelopeSchema,
  groupPlanJsonSchema,
  groupSelectionSchema,
  groupSelectionEnvelopeSchema,
  groupSelectionJsonSchema,
} from '../src/types/group-llm';

describe('grouped provider contracts', () => {
  it('accepts only a strict one-to-three query envelope with required target indices', () => {
    expect(groupPlanEnvelopeSchema.safeParse({
      queries: [{ query: 'Example S01', categories: [5000], targetIndices: [0, 1] }],
    }).success).toBe(true);
    expect(groupPlanEnvelopeSchema.safeParse({ queries: [{ query: 'Example', categories: [5000] }] }).success).toBe(false);
    expect(groupPlanEnvelopeSchema.safeParse({ queries: [{ query: 'Example', categories: [5000], targetIndices: [0], extra: true }] }).success).toBe(false);
    expect(groupPlanEnvelopeSchema.safeParse({ queries: [] }).success).toBe(false);
    expect(groupPlanJsonSchema.additionalProperties).toBe(false);
  });

  it('requires every selection field and a local nonempty release set for grab', () => {
    const base = { verdict: 'grab', releaseIndices: [0], manualTargetIndices: [], deferredTargetIndices: [], reason: 'covers targets' };
    expect(groupSelectionEnvelopeSchema.safeParse({ selection: base }).success).toBe(true);
    expect(groupSelectionEnvelopeSchema.safeParse({ selection: { ...base, releaseIndices: [] } }).success).toBe(false);
    expect(groupSelectionEnvelopeSchema.safeParse({ selection: { ...base, releaseIndices: [0, 1, 2, 3] } }).success).toBe(false);
    expect(groupSelectionEnvelopeSchema.safeParse({ selection: { ...base, deferredTargetIndices: undefined } }).success).toBe(false);
    expect(groupSelectionEnvelopeSchema.safeParse({ selection: { ...base, verdict: 'skip', releaseIndices: [0] } }).success).toBe(false);
    expect(groupSelectionEnvelopeSchema.safeParse({ selections: [base] }).success).toBe(false);
    expect(groupSelectionSchema.safeParse({ ...base, verdict: 'manual', releaseIndices: [] }).success).toBe(true);

    const jsonSelection = groupSelectionJsonSchema.properties.selection;
    expect(groupSelectionJsonSchema.properties).toHaveProperty('selection');
    expect(groupSelectionJsonSchema.required).toEqual(['selection']);
    expect(groupSelectionJsonSchema.additionalProperties).toBe(false);
    expect(jsonSelection.required).toEqual(['verdict', 'releaseIndices', 'manualTargetIndices', 'deferredTargetIndices', 'reason']);
    expect(jsonSelection.additionalProperties).toBe(false);
    expect(jsonSelection.properties.releaseIndices.maxItems).toBe(3);
    expect(jsonSelection).not.toHaveProperty('allOf');
    expect(jsonSelection).not.toHaveProperty('anyOf');
    expect(groupSelectionEnvelopeSchema.safeParse({ selection: { ...base, releaseIndices: [0, 1, 2, 3] } }).success).toBe(false);
  });

  it('requires strict indexed association decisions with explicit outcomes', () => {
    expect(associationResponseSchema.safeParse({ decisions: [{
      queueIndex: 0, outcome: 'uncertain', mediaIndices: [], targetIndices: [], reason: 'title alone is insufficient',
    }] }).success).toBe(true);
    expect(associationResponseSchema.safeParse({ decisions: [{
      queueIndex: 0, outcome: 'matched', mediaIndices: [0], targetIndices: [],
    }] }).success).toBe(false);
    expect(associationResponseSchema.safeParse({ decisions: [], downloadId: 'secret' }).success).toBe(false);
    expect(associationResponseJsonSchema.additionalProperties).toBe(false);
  });
});
