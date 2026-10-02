import { z } from 'zod';

const groupPlannedQuerySchema = z.object({
  query: z.string().min(1).max(300),
  categories: z.array(z.number().int()).min(1).max(4),
  targetIndices: z.array(z.number().int().nonnegative()).min(1),
}).strict();

export const groupPlanEnvelopeSchema = z.object({
  queries: z.array(groupPlannedQuerySchema).min(1).max(3),
}).strict();

export type GroupPlannedQuery = z.infer<typeof groupPlannedQuerySchema>;
export type GroupPlanEnvelope = z.infer<typeof groupPlanEnvelopeSchema>;

export const groupPlanJsonSchema = {
  type: 'object',
  properties: {
    queries: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 300 },
          categories: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 4 },
          targetIndices: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1 },
        },
        required: ['query', 'categories', 'targetIndices'],
        additionalProperties: false,
      },
    },
  },
  required: ['queries'],
  additionalProperties: false,
} as const;

export const groupSelectionSchema = z.object({
  verdict: z.enum(['grab', 'manual', 'skip']),
  releaseIndices: z.array(z.number().int().nonnegative()).max(3),
  manualTargetIndices: z.array(z.number().int().nonnegative()),
  deferredTargetIndices: z.array(z.number().int().nonnegative()),
  reason: z.string().min(1),
}).strict().superRefine((selection, context) => {
  if (selection.verdict === 'grab' && selection.releaseIndices.length === 0) {
    context.addIssue({ code: 'custom', message: 'grab requires at least one release index', path: ['releaseIndices'] });
  }
  if (selection.verdict !== 'grab' && selection.releaseIndices.length !== 0) {
    context.addIssue({ code: 'custom', message: 'manual and skip selections cannot choose releases', path: ['releaseIndices'] });
  }
});

export const groupSelectionEnvelopeSchema = z.object({
  selection: groupSelectionSchema,
}).strict();

export type GroupSelection = z.infer<typeof groupSelectionSchema>;
export type GroupSelectionEnvelope = z.infer<typeof groupSelectionEnvelopeSchema>;

export const groupSelectionJsonSchema = {
  type: 'object',
  properties: {
    selection: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['grab', 'manual', 'skip'] },
        releaseIndices: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 3 },
        manualTargetIndices: { type: 'array', items: { type: 'integer', minimum: 0 } },
        deferredTargetIndices: { type: 'array', items: { type: 'integer', minimum: 0 } },
        reason: { type: 'string', minLength: 1 },
      },
      required: ['verdict', 'releaseIndices', 'manualTargetIndices', 'deferredTargetIndices', 'reason'],
      additionalProperties: false,
    },
  },
  required: ['selection'],
  additionalProperties: false,
} as const;

export const associationResponseSchema = z.object({
  decisions: z.array(z.object({
    queueIndex: z.number().int().nonnegative(),
    outcome: z.enum(['matched', 'unrelated', 'uncertain']),
    mediaIndices: z.array(z.number().int().nonnegative()),
    targetIndices: z.array(z.number().int().nonnegative()),
    reason: z.string().min(1),
  }).strict()),
}).strict();

export type AssociationResponse = z.infer<typeof associationResponseSchema>;

export const associationResponseJsonSchema = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          queueIndex: { type: 'integer', minimum: 0 },
          outcome: { type: 'string', enum: ['matched', 'unrelated', 'uncertain'] },
          mediaIndices: { type: 'array', items: { type: 'integer', minimum: 0 } },
          targetIndices: { type: 'array', items: { type: 'integer', minimum: 0 } },
          reason: { type: 'string', minLength: 1 },
        },
        required: ['queueIndex', 'outcome', 'mediaIndices', 'targetIndices', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['decisions'],
  additionalProperties: false,
} as const;
