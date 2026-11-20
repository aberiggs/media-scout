/** Safe receipt projection types only. Release execution is deferred. */
export interface SubmissionResult {
  searchId: string;
  optionId: string;
  outcome: 'submitted' | 'rejected' | 'uncertain' | 'deferred' | 'conflict' | 'failed' | 'dry-run' | 'expired';
  message?: string;
  candidateIds: string[];
  outcomes: Array<{ candidateId: string; outcome: string }>;
}
