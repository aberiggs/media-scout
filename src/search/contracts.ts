import { z } from 'zod';

export const searchRequestSchema = z.object({
  prompt: z.string().min(1).max(4000).refine(value => value.trim().length > 0, 'Prompt must not be blank'),
}).strict();
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export const acquisitionRequestSchema = searchRequestSchema.extend({ downloadClientId: z.number().int().positive() }).strict();
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
export const airingOffsetSchema = z.object({ hoursEarly: z.number().int().min(0).max(168) }).strict();

export const searchStatusSchema = z.enum(['queued', 'running', 'matched', 'no-match', 'needs-input', 'budget-exhausted', 'failed', 'interrupted']);
export type SearchStatus = z.infer<typeof searchStatusSchema>;
export const activityStatusSchema = z.union([searchStatusSchema, z.enum(['submitted', 'rejected', 'uncertain', 'deferred', 'dry-run', 'partial', 'not-attempted'])]);
