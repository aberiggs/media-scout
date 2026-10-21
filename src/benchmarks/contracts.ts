import { z } from 'zod';

const SafeText = z.string().max(4000).refine((s) => !/([a-z][a-z0-9+.-]*:\/\/|magnet:|\bBearer\s+\S+|\bsk-(?:or-|proj-|ant-)|(?:api[_-]?key|token|password|authorization)\s*[:=]|[a-f0-9]{32,}|\[[a-f0-9]{8}\])/i.test(s), 'unsafe persisted text');
export const BenchmarkTextSchema = SafeText;
const Id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const Num = z.number().finite();
const Nonnegative = Num.nonnegative();
const NullableNumber = Num.nullable();
const EpisodeSchema = z.object({ episodeNumber: Nonnegative.int(), absoluteEpisodeNumber: Nonnegative.int().nullable(), title: SafeText }).strict();
const InputSchema = z.object({ kind: z.enum(['movie', 'tv', 'anime']), title: SafeText, altTitles: z.array(SafeText).max(100), externalId: SafeText.nullable(), year: z.number().int().nullable(), seasonNumber: z.number().int().nonnegative().nullable(), episodes: z.array(EpisodeSchema).max(1000) }).strict();
const CandidateReview = z.object({ identity: z.enum(['compatible', 'wrong', 'unresolved']), coveredEpisodeNumbers: z.array(Nonnegative), coverageBasis: z.enum(['explicit', 'inferred', 'unknown']), selection: z.enum(['acceptable', 'unacceptable', 'uncertain']), reason: SafeText, preferenceTier: z.number().int().min(0).max(4).optional() }).strict();
export const CandidateSchema = z.object({ id: Id, title: SafeText, downloadPresent: z.boolean(), magnetPresent: z.boolean(), size: Nonnegative.nullable(), seeders: Nonnegative.nullable(), leechers: Nonnegative.nullable(), grabs: Nonnegative.nullable(), age: NullableNumber, externalIds: z.array(SafeText).max(100), protocol: SafeText, categories: z.array(z.number().int()).max(100), source: Id, review: CandidateReview.optional() }).strict();
const QuerySchema = z.object({ query: SafeText, categories: z.array(z.number().int()).max(100), indexers: z.array(Id).max(100), limit: z.number().int().positive(), candidateIds: z.array(Id).max(1000), originalCount: Nonnegative.optional(), observedAt: z.string().datetime({ offset: true }).optional(), availability: z.enum(['success', 'unavailable']), completeness: z.literal('upstream-completeness-unknown') }).strict();
export const DatasetLabelSchema = z.object({ identity: z.enum(['compatible', 'wrong', 'unresolved']), coveredEpisodeNumbers: z.array(Nonnegative).max(1000), coverageBasis: z.enum(['explicit', 'inferred', 'unknown']), selection: z.enum(['acceptable', 'unacceptable', 'uncertain']), acceptableCandidateIds: z.array(Id).max(500), reason: SafeText }).strict();
export const DatasetCaseSchema = z.object({ id: Id, partition: z.enum(['development', 'held-out']), input: InputSchema, candidates: z.array(CandidateSchema).max(500), queries: z.array(QuerySchema).max(1000), label: DatasetLabelSchema, held: z.boolean().optional(), associationExpectation: z.enum(['matched', 'unrelated', 'uncertain']).optional(), queueTitle: SafeText.optional() }).strict();
export const DatasetSchema = z.object({ schemaVersion: z.literal(1), id: Id, revision: z.number().int().positive(), labelStatus: z.enum(['proposed', 'reviewed']).default('proposed'), createdAt: z.string().datetime(), provenance: z.object({ sourcePurpose: SafeText, observedAt: z.string().datetime(), completeness: z.literal('upstream-completeness-unknown'), notes: SafeText }).strict(), cases: z.array(DatasetCaseSchema).max(10000) }).strict().superRefine((data, ctx) => {
  const caseIds = new Set<string>();
  for (const c of data.cases) {
    if (caseIds.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate case id ${c.id}` }); caseIds.add(c.id);
    const candidateIds = new Set<string>();
    for (const candidate of c.candidates) { if (candidateIds.has(candidate.id)) ctx.addIssue({ code: 'custom', message: `duplicate candidate id ${candidate.id}` }); candidateIds.add(candidate.id); }
    const queryKeys = new Set<string>();
    for (const q of c.queries) {
      const key = JSON.stringify([q.query, q.categories, q.indexers, q.limit]);
      if (queryKeys.has(key)) ctx.addIssue({ code: 'custom', message: 'duplicate exact query' }); queryKeys.add(key);
      if (new Set(q.candidateIds).size !== q.candidateIds.length || q.candidateIds.some((id) => !candidateIds.has(id))) ctx.addIssue({ code: 'custom', message: 'query candidate references must be unique and local to case' });
    }
    if (new Set(c.label.acceptableCandidateIds).size !== c.label.acceptableCandidateIds.length || c.label.acceptableCandidateIds.some((id) => !candidateIds.has(id))) ctx.addIssue({ code: 'custom', message: 'acceptable candidate references must be unique and local to case' });
    if (new Set(c.label.coveredEpisodeNumbers).size !== c.label.coveredEpisodeNumbers.length || c.label.coveredEpisodeNumbers.some((n) => !c.input.episodes.some((e) => e.episodeNumber === n))) ctx.addIssue({ code: 'custom', message: 'coverage episode references must be unique and local to input' });
  }
});
export const AttemptSchema = z.object({ id: Id, status: z.enum(['pending', 'succeeded', 'failed', 'refused']), startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(), model: SafeText.nullable(), latencyMs: Nonnegative.nullable(), correctionId: Id.nullable(), transportId: Id, inputTokens: Nonnegative.nullable(), outputTokens: Nonnegative.nullable(), cost: Nonnegative.nullable(), failure: z.enum(['timeout', 'provider-error', 'invalid-output', 'refusal', 'invalid-json', 'schema-error', 'unsupported-strict', 'cancel']).nullable(), schemaValid: z.boolean().nullable(), logicalCallId: Id.optional(), promptHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), caseId: Id.optional(), track: Id.optional() }).strict();
export const LaunchSchema = z.object({
  requestId: Id, datasetId: Id, datasetRevision: z.number().int().positive(),
  profileId: Id, model: SafeText.min(1), prompt: z.enum(['production-v1', 'benchmark-data-only-v1']),
  tracks: z.array(z.enum(['plan-single', 'plan-group', 'pick-single', 'pick-group', 'association', 'replay'])).min(1).max(6),
  split: z.enum(['all', 'development', 'held-out']), repeats: z.number().int().min(1).max(3),
  maxAttempts: z.number().int().min(1).max(500), maxTokens: z.number().int().min(1).max(500_000_000),
  maxOutputTokens: z.number().int().min(64).max(8192), maxSeconds: z.number().int().min(1).max(1800),
  temperature: z.number().finite().min(0).max(2).default(0), seed: z.number().int().nonnegative().nullable().default(null),
  spendPolicy: z.enum(['hard-dollar', 'local-call-token']).default('hard-dollar'),
  maxDollars: z.number().finite().min(0.01).max(25), disclosureApproved: z.literal(true),
}).strict().refine(v => new Set(v.tracks).size === v.tracks.length, 'duplicate tracks');
export const ResultSchema = z.object({
  caseId: Id, track: Id, status: z.enum(['correct', 'incorrect', 'justified-abstention', 'avoidable-abstention', 'uncertain', 'unsafe-proposal', 'validator-rejected', 'provider-failure', 'unsupported-retrieval', 'retrieval-unavailable']),
  unsafe: z.boolean(), validatorRejected: z.boolean(), selectedIds: z.array(Id), rawIndices: z.array(z.number().int()), failure: z.enum(['schema', 'provider', 'semantic']).nullable(),
  queries: z.array(z.object({ query: SafeText, categories: z.array(z.number().int()), targetIndices: z.array(z.number().int().nonnegative()).optional(), episodeTargets: z.array(z.object({ targetIndex: z.number().int().nonnegative(), episodeIndices: z.array(z.number().int().nonnegative()) }).strict()).optional() }).strict()), supportedQueryCount: Nonnegative, unsupportedQueryCount: Nonnegative,
  admittedIds: z.array(Id), retrievedIds: z.array(Id), cappedIds: z.array(Id), admissionLossIds: z.array(Id), capLossIds: z.array(Id), poolRecall: Nonnegative.max(1).nullable(), reviewedCandidates: Nonnegative, uncertainCandidates: Nonnegative, association: z.enum(['matched', 'unrelated', 'uncertain']).nullable(),
  malformedProposal: z.boolean(), latencyMs: Nonnegative.optional(), attemptIds: z.array(Id).max(500).optional(), repeat: Nonnegative.optional(),
  identityCorrect: z.boolean().nullable(), claimedTargetCoverage: Nonnegative.max(1).nullable(), selectionCoverageBasis: z.enum(['explicit', 'inferred', 'mixed', 'unknown']),
  preferenceCredit: Nonnegative.max(1).nullable(),
}).strict();
export const RunSchema = z.object({ schemaVersion: z.literal(1), id: Id, datasetId: Id, datasetRevision: z.number().int().positive(), status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'budget-exhausted']), attempts: z.array(AttemptSchema).max(500),
  config: LaunchSchema.optional(), createdAt: z.string().datetime().optional(), finishedAt: z.string().datetime().nullable().optional(), cancelRequested: z.boolean().optional(),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  priceBound: z.object({ contextTokens: z.number().int().positive(), promptPerMillion: Nonnegative, completionPerMillion: Nonnegative, request: z.literal(0), observedAt: z.string().datetime(), seedSupported: z.boolean().optional(), accounting: z.enum(['hosted-bound', 'local-unknown']).optional() }).strict().optional(),
  results: z.array(ResultSchema).max(500).optional(), plannedCases: Nonnegative.optional(), stopReason: z.enum(['cancel', 'deadline', 'allowance', 'storage', 'execution']).nullable().optional(),
}).strict();
export type Dataset = z.infer<typeof DatasetSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Launch = z.infer<typeof LaunchSchema>;
