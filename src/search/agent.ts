import { callModel, stepCountIs, tool } from '@openrouter/agent';
import { createMCPTools } from '@openrouter/agent/mcp';
import { finalizeReleaseSetInputSchema, type FinalizationLedger, type ReleaseSet, finalizeReleaseSet } from './agent-contracts';
import { connectResearchTools, type enabledResearchServerConfigs } from './research-mcp';

export interface AgentSearchOptions {
  client: Parameters<typeof callModel>[0];
  model: string;
  input: string;
  instructions?: string;
  mcpUrl: string;
  capability: string;
  researchServers?: ReturnType<typeof enabledResearchServerConfigs>;
  researchSecrets?: readonly string[];
  signal: AbortSignal;
  maxSteps: number;
  requestTimeoutMs: number;
  ledger: () => FinalizationLedger;
  ownsSearch: () => boolean;
  sanitizeFinalizerInput?: (input: unknown) => unknown;
  onFinalize: (result: ReleaseSet) => Promise<void> | void;
  onModelTurn?: (turn: number) => void;
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cost?: number }) => void;
  onResearchWarning?: (message: string) => void;
}
export class AgentBudgetExhaustedError extends Error {
  constructor() { super('Agent step budget exhausted without a validated release set'); this.name = 'AgentBudgetExhaustedError'; }
}

/** SDK-managed Responses tool loop; only the validated finalizer can accept a plan. */
export async function runAgentSearch(options: AgentSearchOptions): Promise<ReleaseSet> {
  const handle = await createMCPTools({
    url: options.mcpUrl,
    transport: 'streamableHttp',
    auth: { kind: 'bearer', token: options.capability },
    signal: options.signal,
    resources: false,
  });
  let external: Awaited<ReturnType<typeof connectResearchTools>> | undefined;
  let finalized: ReleaseSet | undefined;
  let finalizing = false;
  let modelTurns = 0;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) abort();
  else options.signal.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal.aborted) throw options.signal.reason ?? new Error('aborted');
    if (options.researchServers?.length) {
      external = await connectResearchTools(options.researchServers, controller.signal, options.researchSecrets ?? [], options.onResearchWarning);
    }
    const finalizer = tool({
      name: 'finalize_release_set',
      description: 'Finalize exactly one release set from observed candidates. Call only when research is complete.',
      inputSchema: finalizeReleaseSetInputSchema,
      timeoutMs: options.requestTimeoutMs,
      execute: async (input, context) => {
        if (context?.signal.aborted || options.signal.aborted) throw context?.signal.reason ?? options.signal.reason;
        if (modelTurns > options.maxSteps) throw new AgentBudgetExhaustedError();
        if (finalized || finalizing) throw new Error('Release set already finalized');
        if (!options.ownsSearch()) throw new Error('Search ownership lost');
        finalizing = true;
        try {
          const validated = finalizeReleaseSet(options.sanitizeFinalizerInput?.(input) ?? input, options.ledger());
          await options.onFinalize(validated);
          if (!options.ownsSearch() || options.signal.aborted) throw new Error('Search ownership lost');
          finalized = validated;
          controller.abort(new Error('release-set-finalized'));
          return { accepted: true, status: validated.status, selectedCount: validated.selections.length };
        } finally { finalizing = false; }
      },
    });
    const result = callModel(options.client, {
      model: options.model,
      input: options.input,
      ...(options.instructions ? { instructions: options.instructions } : {}),
      tools: [...handle.tools, ...(external?.tools ?? []), finalizer] as const,
      stopWhen: [stepCountIs(options.maxSteps), () => !!finalized],
      allowFinalResponse: false,
      signal: controller.signal,
      toolTimeoutMs: options.requestTimeoutMs,
      onTurnStart: () => { modelTurns++; options.onModelTurn?.(modelTurns); },
      onTurnEnd: (_context, response) => {
        const usage = response.usage;
        if (!usage) return;
        const projection = {
          ...(Number.isFinite(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
          ...(Number.isFinite(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
          ...(Number.isFinite(usage.totalTokens) ? { totalTokens: usage.totalTokens } : {}),
          ...(typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? { cost: usage.cost } : {}),
        };
        if (Object.keys(projection).length) options.onUsage?.(projection);
      },
    }, { timeoutMs: options.requestTimeoutMs });
    try { await result.getResponse(); }
    catch (error) { if (!finalized) throw error; }
    if (finalized) return finalized;
    if (!finalized) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (modelTurns >= options.maxSteps) throw new AgentBudgetExhaustedError();
      throw new Error('Agent stopped without a validated release set');
    }
    return finalized;
  } finally {
    options.signal.removeEventListener('abort', abort);
    controller.abort();
    try { await external?.close(); } catch { /* Preserve the run's actual outcome. */ }
    try { await handle.close(); } catch { /* Preserve the run's actual outcome. */ }
  }
}
