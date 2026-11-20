import { z } from 'zod';

export const EPISODE_SET_LIMITS = {
  targets: 200, relatedEpisodes: 5000,
  requestBytes: 48_000,
} as const;

const nonempty = z.string().trim().min(1);
const languagePreferences = z.object({ audioLanguages: z.array(nonempty).optional(), subtitleLanguages: z.array(nonempty).optional(), resolutions: z.array(nonempty).optional(), notes: z.string().max(4000).optional() }).strict();
const targetContext = z.object({ targetId: nonempty, seasonNumber: z.number().int().nonnegative().optional(), episodeNumber: z.number().int().positive().optional(), absoluteEpisodeNumber: z.number().int().positive().optional(), title: nonempty.optional(), airDateUtc: z.string().datetime().nullable().optional() }).strict();
const relatedEpisodeContext = z.object({ episodeRef: nonempty, seasonNumber: z.number().int().nonnegative().optional(), episodeNumber: z.number().int().positive().optional(), absoluteEpisodeNumber: z.number().int().positive().optional(), title: nonempty.optional(), airDateUtc: z.string().datetime().nullable().optional(), hasFile: z.boolean(), queued: z.boolean(), monitored: z.boolean(), available: z.boolean(), contextReason: nonempty }).strict();
const requestContext = z.object({
  kind: z.enum(['tv', 'movie', 'other']).optional(),
  titles: z.array(nonempty).optional(), year: z.number().int().min(1888).max(2200).optional(),
  externalIds: z.record(nonempty, z.union([nonempty, z.number().int().nonnegative()])).optional(),
  scope: z.object({ type: z.enum(['episode', 'season', 'movie', 'unspecified', 'episode-set']), seasonNumber: z.number().int().nonnegative().optional(), episodeNumber: z.number().int().positive().optional(), absoluteEpisodeNumber: z.number().int().positive().optional() }).strict().optional(),
  targets: z.array(targetContext).optional(),
  relatedEpisodes: z.array(relatedEpisodeContext).max(EPISODE_SET_LIMITS.relatedEpisodes).optional(),
  relatedEpisodesOmitted: z.number().int().nonnegative().optional(),
  overview: z.string().max(4000).optional(), originalLanguage: nonempty.optional(), seriesType: z.enum(['standard', 'anime', 'daily']).optional(),
  profileContext: z.object({ qualities: z.array(nonempty).optional(), customFormats: z.array(nonempty).optional(), unknown: z.boolean().optional() }).strict().optional(),
  episodeTitle: nonempty.optional(),
}).strict();
export const searchRequestSchema = z.object({
  prompt: nonempty.max(4000), context: requestContext.optional(), preferences: languagePreferences.optional(),
  arrTargetIds: z.array(nonempty.max(200)).max(200).optional(),
  preferredDownloadClientId: z.number().int().positive().optional(),
}).strict().superRefine((request, ctx) => {
  if (request.arrTargetIds && new Set(request.arrTargetIds).size !== request.arrTargetIds.length)
    ctx.addIssue({ code: 'custom', path: ['arrTargetIds'], message: 'Arr target IDs must be distinct' });
  if (request.context?.targets && new Set(request.context.targets.map(target => target.targetId)).size !== request.context.targets.length)
    ctx.addIssue({ code: 'custom', path: ['context', 'targets'], message: 'Target IDs must be distinct' });
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > EPISODE_SET_LIMITS.requestBytes)
    ctx.addIssue({ code: 'custom', path: [], message: 'Search request exceeds the byte limit' });
  if (request.context?.scope?.type !== 'episode-set') return;
  const targets = request.context.targets ?? [];
  if (!targets.length || targets.length > EPISODE_SET_LIMITS.targets)
    ctx.addIssue({ code: 'custom', path: ['context', 'targets'], message: 'Episode sets require 1–200 acquisition targets' });
  if (new Set(targets.map(t => t.targetId)).size !== targets.length)
    ctx.addIssue({ code: 'custom', path: ['context', 'targets'], message: 'Episode-set target IDs must be distinct' });
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchStatusSchema = z.enum(['queued', 'running', 'matched', 'no-match', 'needs-input', 'budget-exhausted', 'failed', 'interrupted']);
export type SearchStatus = z.infer<typeof searchStatusSchema>;
export const submissionRequestSchema = z.object({ searchId: nonempty, optionId: nonempty, idempotencyKey: nonempty.max(200), downloadClientId: z.number().int().positive().optional() }).strict();
export type SubmissionRequest = z.infer<typeof submissionRequestSchema>;
export const submissionOutcomeSchema = z.enum(['submitting', 'submitted', 'rejected', 'uncertain', 'deferred', 'conflict', 'failed', 'dry-run', 'expired']);
export type SubmissionOutcome = z.infer<typeof submissionOutcomeSchema>;
export const activityStatusSchema = z.union([searchStatusSchema, submissionOutcomeSchema, z.enum(['partial', 'not-attempted'])]);
