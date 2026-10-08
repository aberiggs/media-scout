import { createHash } from 'node:crypto';
import type { GeneralSearchStopReason } from '../types/general-search';

export interface SearchLedger {
  raw: number;
  added: number;
  duplicates: number;
  reactivated: number;
  reassessed: number;
  filtered: Record<string, number>;
  assessed: { match: number; possible: number; unrelated: number; unassessed: number };
  queries: Array<{ query: string; outcome: 'pending' | 'success' | 'failed'; raw: number; added: number }>;
}

export function createSearchLedger(): SearchLedger {
  return { raw: 0, added: 0, duplicates: 0, reactivated: 0, reassessed: 0, filtered: {}, assessed: { match: 0, possible: 0, unrelated: 0, unassessed: 0 }, queries: [] };
}

export function countFilter(ledger: SearchLedger, reason: string): void {
  ledger.filtered[reason] = (ledger.filtered[reason] ?? 0) + 1;
}

export function chooseStopReason(input: {
  sufficient: boolean; noNovelty: boolean; lowYieldRounds: number; budget: boolean; deadline: boolean; exhausted: boolean;
}): GeneralSearchStopReason {
  if (input.sufficient) return 'sufficient-results';
  if (input.deadline) return 'deadline';
  if (input.budget) return 'budget-exhausted';
  if (input.noNovelty) return 'no-novelty';
  if (input.lowYieldRounds >= 2) return 'low-yield';
  return input.exhausted ? 'proposals-exhausted' : 'completed';
}

export function constraintFingerprint(space: unknown): string {
  return createHash('sha256').update(JSON.stringify(space ?? null)).digest('hex');
}
