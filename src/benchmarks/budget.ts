/** Conservative, per-transport-attempt budget reservations for benchmark calls. */
export interface AttemptAllowance {
  calls: number;
  tokens: number;
  /** Conservative currency units; null means no hard dollar ceiling. */
  cost: number | null;
}

export interface RequestBound {
  maxOutputTokens: number;
  inputCostPerToken: number;
  outputCostPerToken: number;
  /** Optional provider-independent conservative input-token bound. */
  inputTokens?: number;
  /** Required to enable hard-dollar mode. */
  hardMaxDollar?: number;
}

/** UTF-8 bytes bound token count conservatively; framing adds one token per message. */
export function conservativePromptTokens(messages: readonly string[]): number {
  return messages.reduce((sum, message) => sum + Buffer.byteLength(message, 'utf8') + 1, 0);
}

export class AttemptBudget {
  private readonly unsettled = new Set<AttemptAllowance>();
  private invalidated = false;
  private reservedCalls = 0;
  private reservedTokens = 0;
  private reservedCost = 0;
  private actualKnownCost = 0;

  constructor(private readonly limits: AttemptAllowance) {
    if (!Number.isSafeInteger(limits.calls) || limits.calls < 1 || !Number.isSafeInteger(limits.tokens) || limits.tokens < 1 || (limits.cost !== null && (!Number.isFinite(limits.cost) || limits.cost < 0))) throw new Error('Invalid allowance');
  }

  reserve(bound: RequestBound, prompt: readonly string[]): AttemptAllowance {
    if (this.invalidated) throw new Error('Benchmark cost bound contradicted; allowance invalidated');
    if (this.limits.cost !== null && bound.inputTokens === undefined) throw new Error('Hard-dollar mode requires a verified whole-request token bound');
    if (!Number.isInteger(bound.maxOutputTokens) || bound.maxOutputTokens <= 0) throw new Error('Invalid output token bound');
    const inputTokens = bound.inputTokens ?? conservativePromptTokens(prompt);
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || !Number.isFinite(bound.inputCostPerToken) || bound.inputCostPerToken < 0 || !Number.isFinite(bound.outputCostPerToken) || bound.outputCostPerToken < 0) throw new Error('Hard-dollar mode requires a conservative request cost bound');
    const cost = inputTokens * bound.inputCostPerToken + bound.maxOutputTokens * bound.outputCostPerToken;
    if (bound.hardMaxDollar !== undefined && !Number.isFinite(cost)) throw new Error('Hard-dollar mode requires a conservative request cost bound');
    if (bound.hardMaxDollar !== undefined && cost > bound.hardMaxDollar) throw new Error('Request exceeds hard-dollar maximum');
    if (this.reservedCalls + 1 > this.limits.calls || this.reservedTokens + inputTokens + bound.maxOutputTokens > this.limits.tokens ||
      (this.limits.cost !== null && this.reservedCost + cost > this.limits.cost)) throw new Error('Benchmark allowance exhausted');
    this.reservedCalls++;
    this.reservedTokens += inputTokens + bound.maxOutputTokens;
    this.reservedCost += cost;
    const reservation = Object.freeze({ calls: 1, tokens: inputTokens + bound.maxOutputTokens, cost });
    this.unsettled.add(reservation);
    return reservation;
  }

  /** Reliable observed cost releases unused reservation; unknown/inconsistent costs remain reserved. */
  settle(reservation: AttemptAllowance, actualCost: number | null): void {
    if (!this.unsettled.delete(reservation)) throw new Error('Reservation already settled or unknown');
    if (actualCost === null || !Number.isFinite(actualCost) || actualCost < 0 || reservation.cost === null) return;
    if (actualCost > reservation.cost) { this.actualKnownCost += actualCost; this.reservedCost += actualCost - reservation.cost; this.invalidated = true; return; }
    this.reservedCost -= reservation.cost - actualCost;
    this.actualKnownCost += actualCost;
  }

  snapshot(): { reserved: AttemptAllowance; knownActualCost: number } {
    return { reserved: { calls: this.reservedCalls, tokens: this.reservedTokens, cost: this.limits.cost === null ? null : this.reservedCost }, knownActualCost: this.actualKnownCost };
  }
}
