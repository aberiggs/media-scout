import { z } from 'zod';

export const searchRequestSchema = z.object({
  prompt: z.string().min(1).max(4000).refine(value => value.trim().length > 0, 'Prompt must not be blank'),
}).strict();
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchStatusSchema = z.enum(['queued', 'running', 'matched', 'no-match', 'needs-input', 'budget-exhausted', 'failed', 'interrupted']);
export type SearchStatus = z.infer<typeof searchStatusSchema>;
export const activityStatusSchema = z.union([searchStatusSchema, z.enum(['submitted', 'rejected', 'uncertain', 'deferred', 'dry-run', 'partial', 'not-attempted'])]);
