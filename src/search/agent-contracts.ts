import { z } from 'zod';
import { createHash } from 'node:crypto';

const nonempty = z.string().trim().min(1);

const broadStatus = z.enum(['complete', 'partial', 'none', 'unknown']);
const semanticCoverage = z.object({
  covered: z.array(nonempty),
  gaps: z.array(nonempty),
  deferred: z.array(nonempty),
  broad: z.object({ status: broadStatus, gaps: z.array(nonempty) }).strict(),
}).strict();

export const finalizeReleaseSetInputSchema = z.object({
  status: z.enum(['matched', 'no-match', 'needs-input']),
  selections: z.array(z.object({
    candidateId: nonempty,
    coverage: nonempty.max(2000),
    reason: nonempty.max(2000),
    uncertainty: z.string().max(2000),
  }).strict()),
  covered: z.array(nonempty),
  gaps: z.array(nonempty),
  deferred: z.array(nonempty),
  broadCoverage: broadStatus,
  scopeGaps: z.array(nonempty),
  extras: z.array(nonempty).optional(),
  usefulOverlap: z.array(nonempty).optional(),
  warnings: z.array(nonempty).optional(),
  message: z.string().max(2000).optional(),
}).strict().superRefine((output, ctx) => {
  if (output.status === 'matched' && output.selections.length === 0)
    ctx.addIssue({ code: 'custom', path: ['selections'], message: 'Matched release set requires a selection' });
  if (output.status === 'matched' && output.covered.length === 0)
    ctx.addIssue({ code: 'custom', path: ['covered'], message: 'Matched release set requires a plain-language coverage description' });
  if (output.status !== 'matched' && output.selections.length > 0)
    ctx.addIssue({ code: 'custom', path: ['selections'], message: 'Only matched plans may select releases' });
  const hasUncoveredScope = output.gaps.length > 0 || output.deferred.length > 0 || output.scopeGaps.length > 0;
  if (output.broadCoverage === 'complete' && output.status !== 'matched')
    ctx.addIssue({ code: 'custom', path: ['broadCoverage'], message: 'Complete broad coverage requires a matched release set' });
  if (output.broadCoverage === 'complete' && hasUncoveredScope)
    ctx.addIssue({ code: 'custom', path: ['broadCoverage'], message: 'Complete broad coverage cannot contain gaps or deferred scope' });
  if (output.broadCoverage === 'partial' && !hasUncoveredScope)
    ctx.addIssue({ code: 'custom', path: ['broadCoverage'], message: 'Partial broad coverage requires explicit gaps or deferred scope' });
  if (output.status === 'no-match' && output.broadCoverage !== 'none')
    ctx.addIssue({ code: 'custom', path: ['broadCoverage'], message: 'No-match must report no broad coverage' });
  if (output.broadCoverage === 'none' && output.status === 'matched')
    ctx.addIssue({ code: 'custom', path: ['broadCoverage'], message: 'Matched release set cannot report no broad coverage' });
});

export const releaseSetSchema = finalizeReleaseSetInputSchema.extend({
  version: z.literal(2),
  planId: nonempty,
  coverage: semanticCoverage,
});
export type ReleaseSet = z.infer<typeof releaseSetSchema>;

export interface LedgerCandidate {
  id: string;
  physicalId: string;
}
export interface FinalizationLedger {
  searchId: string;
  planId?: string;
  candidates: LedgerCandidate[];
}

/** Validate model output only against trusted, owning-search ledger facts. */
export function finalizeReleaseSet(raw: unknown, ledger: FinalizationLedger): ReleaseSet {
  if (!ledger.searchId.trim()) throw new Error('Invalid owning search');
  const input = finalizeReleaseSetInputSchema.parse(raw);
  const candidates = new Map(ledger.candidates.map(candidate => [candidate.id, candidate]));
  if (candidates.size !== ledger.candidates.length) throw new Error('Invalid ledger membership');
  const selectedPhysical = new Set<string>();
  for (const selection of input.selections) {
    const candidate = candidates.get(selection.candidateId);
    if (!candidate) throw new Error('Candidate does not belong to owning search');
    if (selectedPhysical.has(candidate.physicalId)) throw new Error('Duplicate physical release');
    selectedPhysical.add(candidate.physicalId);
  }
  const planId = ledger.planId ?? createHash('sha256').update(ledger.searchId).digest('hex');
  return {
    ...input,
    version: 2,
    planId,
    coverage: {
      covered: input.covered,
      gaps: input.gaps,
      deferred: input.deferred,
      broad: { status: input.broadCoverage, gaps: input.scopeGaps },
    },
  };
}
