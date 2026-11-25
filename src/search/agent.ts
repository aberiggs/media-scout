import { callModel, stepCountIs, tool } from '@openrouter/agent';
import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { finalizeReleaseSetInputSchema, type FinalizationLedger, type ReleaseSet, finalizeReleaseSet } from './agent-contracts';
import { connectResearchTools } from './research-mcp';
import { PROWLARR_INDEXERS_TIMEOUT_MS, PROWLARR_SEARCH_TIMEOUT_MS, prowlarrIndexerTool, prowlarrSearchTool } from './prowlarr-tools';

const CONNECT_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = PROWLARR_SEARCH_TIMEOUT_MS + 10_000;
const INDEXERS_TIMEOUT_MS = PROWLARR_INDEXERS_TIMEOUT_MS + 5_000;
const safeProwlarrErrors = new Set([
  'Prowlarr search timed out.', 'Prowlarr indexer discovery timed out.',
  'Prowlarr search unavailable.', 'Prowlarr indexer discovery unavailable.',
  'provider-cooldown', 'no-healthy-indexers', 'prowlarr-unavailable',
]);
export class ProwlarrConnectionError extends Error {
  constructor(timedOut: boolean) {
    super(timedOut ? 'Prowlarr MCP connection timed out.' : 'Prowlarr MCP connection failed.');
  }
}

export interface AgentSearchOptions {
  client: Parameters<typeof callModel>[0];
  model: string;
  input: string;
  instructions?: string;
  mcpUrl: string;
  capability: string;
  research?: {
    servers: Parameters<typeof connectResearchTools>[0];
    privateValues: readonly string[];
    remainingJobMs: () => number;
  };
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
  onProwlarrTransportFailure?: () => void;
  onProwlarrSearchResult?: () => void;
}
export class AgentBudgetExhaustedError extends Error {
  constructor() { super('Agent step budget exhausted without a validated release set'); this.name = 'AgentBudgetExhaustedError'; }
}

/** SDK-managed Responses tool loop; only the validated finalizer can accept a plan. */
export async function runAgentSearch(options: AgentSearchOptions): Promise<ReleaseSet> {
  const client = new Client({ name: 'media-scout-agent', version: '1.0.0' });
  const connectTimeout = new AbortController();
  const connectSignal = AbortSignal.any([options.signal, connectTimeout.signal]);
  let connecting = true;
  const transport = new StreamableHTTPClientTransport(new URL(options.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${options.capability}` } },
    // The SDK's initialized notification awaits HTTP but does not inherit
    // connect() request options. Cover the entire handshake, not later calls.
    fetch: (input, init) => {
      if (!connecting) return fetch(input, init);
      const transportSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return fetch(input, { ...init, signal: transportSignal ? AbortSignal.any([connectSignal, transportSignal]) : connectSignal });
    },
  });
  // The SDK sends cancellation as an asynchronous JSON-RPC notification.
  // Do not close its HTTP transport before that notification has been sent.
  const cancellationSends = new Set<Promise<void>>();
  const send = transport.send.bind(transport);
  transport.send = (message, sendOptions) => {
    const sent = send(message, sendOptions);
    if ('method' in message && message.method === 'notifications/cancelled') {
      cancellationSends.add(sent);
      void sent.finally(() => cancellationSends.delete(sent)).catch(() => {});
    }
    return sent;
  };
  const closeClient = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...cancellationSends]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); }),
      ]);
      clearTimeout(timer);
      await Promise.race([client.close(), new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
    }
    catch { /* Preserve the run's actual outcome. */ }
    finally { clearTimeout(timer); }
  };
  const connectTimer = setTimeout(() => connectTimeout.abort(), CONNECT_TIMEOUT_MS);
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, signal: connectSignal });
    connectSignal.throwIfAborted();
  } catch (error) {
    await closeClient();
    if (options.signal.aborted) throw options.signal.reason;
    throw new ProwlarrConnectionError(connectTimeout.signal.aborted || (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout));
  } finally { connecting = false; clearTimeout(connectTimer); }
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
    const invoke = async (name: string, args: Record<string, unknown>, contextSignal: AbortSignal | undefined, timeoutMs: number) => {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      const sources = [controller.signal, ...(contextSignal ? [contextSignal] : []), timeout.signal];
      const callController = new AbortController();
      const cancelCall = () => callController.abort('cancelled');
      for (const source of sources) {
        if (source.aborted) cancelCall();
        else source.addEventListener('abort', cancelCall, { once: true });
      }
      const signal = callController.signal;
      let result: Awaited<ReturnType<Client['callTool']>>;
      try {
        signal.throwIfAborted();
        result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs, signal });
        signal.throwIfAborted();
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        options.onProwlarrTransportFailure?.();
        const contextTimedOut = contextSignal?.reason instanceof Error
          && contextSignal.reason.message === `Tool "${name}" timed out after ${timeoutMs + 1_000}ms`;
        const sdkTimedOut = !contextSignal?.aborted && error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
        const message = timeout.signal.aborted || contextTimedOut || sdkTimedOut ? 'Prowlarr tool invocation timed out.' : 'Prowlarr tool invocation failed.';
        options.onResearchWarning?.(message);
        throw new Error(message);
      } finally { clearTimeout(timer); for (const source of sources) source.removeEventListener('abort', cancelCall); }
      const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
      if (result.isError) {
        options.onProwlarrTransportFailure?.();
        const timedOut = text === 'Prowlarr search timed out.' || text === 'Prowlarr indexer discovery timed out.';
        const message = timedOut ? 'Prowlarr tool invocation timed out.' : 'Prowlarr tool invocation failed.';
        options.onResearchWarning?.(message);
        throw new Error(safeProwlarrErrors.has(text) ? text : message);
      }
      // Preserve the wrapper's JSON-text result for these internal tools.
      if (name === prowlarrSearchTool.name) options.onProwlarrSearchResult?.();
      return text;
    };
    const prowlarrTools = [
      tool({ ...prowlarrIndexerTool, timeoutMs: INDEXERS_TIMEOUT_MS + 1_000,
        execute: (args, context) => invoke(prowlarrIndexerTool.name, args, context?.signal, INDEXERS_TIMEOUT_MS) }),
      tool({ ...prowlarrSearchTool, timeoutMs: SEARCH_TIMEOUT_MS + 1_000,
        execute: (args, context) => invoke(prowlarrSearchTool.name, args, context?.signal, SEARCH_TIMEOUT_MS) }),
    ];
    if (options.research?.servers.length) {
      const { servers, privateValues, remainingJobMs } = options.research;
      external = await connectResearchTools(servers, controller.signal, privateValues, remainingJobMs, options.onResearchWarning);
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
      tools: [...prowlarrTools, ...(external?.tools ?? []), finalizer] as const,
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
    await closeClient();
  }
}
