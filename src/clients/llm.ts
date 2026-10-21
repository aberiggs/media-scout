import { z } from 'zod';
import type { OpenRouter } from '@openrouter/sdk';
import { OpenRouterError } from '@openrouter/sdk/models/errors';
import { ApiError } from '../http';
import { createHash, randomUUID } from 'node:crypto';

const JSON_DEADLINE_MS = 60_000;
const RETRY_INITIAL_INTERVAL_MS = 500;
const RETRY_MAX_INTERVAL_MS = 10_000;
const RETRY_EXPONENT = 1.5;

/** The seam core modules and tests program against (FakeLLM in tests). */
export interface LLMClient {
  json<T>(args: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    label: string;
    /** Explicit provider-compatible JSON Schema for refinements/nullable wire fields. */
    jsonSchema?: { name: string; schema: Record<string, unknown> };
  }): Promise<T>;
}

export type LLMFailureCode = 'refusal' | 'invalid-json' | 'schema-error' | 'unsupported-strict' | 'provider-error' | 'timeout' | 'cancel';
export interface LLMAttemptEvent {
  logicalCallId: string;
  attemptId: string;
  attempt: number;
  correction: boolean;
  startedAt: string;
  finishedAt: string;
  model: string | null;
  provider: string | null;
  promptHash: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
  valid: boolean | null;
  failure: LLMFailureCode | null;
}

/**
 * Strips ```json ... ``` / ``` ... ``` markdown fences around LLM JSON output.
 * Live P7 observation: glm-5.3-flash emits ```json-tagged fences, and the old
 * anchored whole-string regex missed them, so JSON.parse choked on the leading
 * backtick. Take the span between the end of the first opening-fence line and
 * the last closing ``` — that also tolerates missing \n after the tag, trailing
 * prose after the fence, and multiple blocks (outermost span). A truncated
 * completion (opening fence but no closing ```) is NOT salvaged: returning the
 * content unchanged makes JSON.parse fail so the existing retry fires.
 */
function stripFences(content: string): string {
  // Unfenced valid JSON passes through untouched: a picker reason can contain
  // ```code``` markup, and a first-open/last-close slice would corrupt it. A
  // real fenced payload starts with a backtick, so extraction still runs for it.
  if (/^\s*[{[]/.test(content)) return content;
  const first = content.indexOf('```');
  if (first === -1) return content;
  // Optional language tag (json, javascript, …) then whitespace; the tag match
  // stops at the first non-tag character, so a missing newline after the tag
  // leaves the JSON body intact.
  const tag = /^[a-zA-Z0-9_-]*\s*/.exec(content.slice(first + 3))?.[0] ?? '';
  const bodyStart = first + 3 + tag.length;
  if (!content.includes('```', bodyStart)) return content;
  const bodyEnd = content.lastIndexOf('```');
  return content.slice(bodyStart, bodyEnd);
}

/** Keep SDK transport metadata typed and safe; never forward its body, URL, or arbitrary headers. */
function normalizeOpenRouterError(error: unknown): unknown {
  if (!(error instanceof OpenRouterError)) return error;
  const header = error.headers.get('retry-after');
  let retryAfter: number | undefined;
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) retryAfter = seconds;
    else {
      const retryDate = Date.parse(header);
      if (Number.isFinite(retryDate)) retryAfter = Math.max(0, Math.ceil((retryDate - Date.now()) / 1000));
    }
  }
  return new ApiError(error.statusCode, 'openrouter-sdk', '', retryAfter);
}

export class OpenRouterLLM implements LLMClient {
  constructor(
    private readonly deps: {
      client: OpenRouter;
      model: string;
      /** Test seam; production calls use the fixed one-minute JSON deadline. */
      timeoutMs?: number;
      signal?: AbortSignal;
      maxOutputTokens?: number;
      maxAttempts?: number;
      onAttempt?: (event: LLMAttemptEvent) => void;
      beforeAttempt?: (request: { serialized: string; maxOutputTokens: number | undefined }) => void;
      providerPriceCeiling?: { prompt: string; completion: string; request: string };
    },
  ) {}

  async json<T>(args: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    label: string;
    jsonSchema?: { name: string; schema: Record<string, unknown> };
    signal?: AbortSignal;
  }): Promise<T> {
    const controller = new AbortController();
    const externalSignal = args.signal ?? this.deps.signal;
    const abort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    const timeoutMs = this.deps.timeoutMs ?? JSON_DEADLINE_MS;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        const error = new Error(`LLM request timed out after ${timeoutMs}ms`);
        error.name = 'TimeoutError';
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });

    const operation = (async () => {
      const logicalCallId = randomUUID();
      let correcting = false;
      let retryIndex = 0;
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (attempt >= (this.deps.maxAttempts ?? Number.POSITIVE_INFINITY)) throw new Error('LLM attempt limit reached');
        const request = {
          model: this.deps.model,
          messages: [
            { role: 'system' as const, content: args.system },
            { role: 'user' as const, content: args.user },
            ...(correcting ? [{ role: 'user' as const, content: 'Correction: Return only a JSON value that conforms to the requested JSON Schema. Do not include prose, markdown, or explanations.' }] : []),
          ],
          responseFormat: { type: 'json_schema' as const, jsonSchema: { name: args.jsonSchema?.name ?? 'llm_output', strict: true, schema: args.jsonSchema?.schema ?? withoutMetaSchema(z.toJSONSchema(args.schema)) } },
          provider: { requireParameters: true, ...(this.deps.providerPriceCeiling ? { maxPrice: this.deps.providerPriceCeiling } : {}) },
          ...(this.deps.maxOutputTokens ? { maxTokens: this.deps.maxOutputTokens } : {}),
        };
        const serialized = JSON.stringify(request);
        this.deps.beforeAttempt?.({ serialized, maxOutputTokens: this.deps.maxOutputTokens });
        const start = Date.now();
        const event: LLMAttemptEvent = { logicalCallId, attemptId: randomUUID(), attempt, correction: correcting,
          startedAt: new Date(start).toISOString(), finishedAt: '', model: null, provider: null,
          promptHash: createHash('sha256').update(serialized).digest('hex'), promptTokens: null, completionTokens: null, cost: null, valid: null, failure: null };
        let retryTransport = false;
        let transportError: unknown;
        try {
          const completion = await this.deps.client.chat.send({ chatRequest: request }, { signal: controller.signal, retries: { strategy: 'none' } });
          if (completion instanceof ReadableStream) { event.failure = 'provider-error'; throw new Error('LLM returned a stream; non-streaming completion required'); }
          // Never persist arbitrary provider-returned strings as model identity.
          event.model = completion.model === this.deps.model ? completion.model : null;
          event.promptTokens = finiteUsage(completion.usage?.promptTokens);
          event.completionTokens = finiteUsage(completion.usage?.completionTokens);
          event.cost = finiteUsage(completion.usage?.cost);
          const message = completion.choices[0]?.message;
          if (typeof message?.refusal === 'string' && message.refusal.trim()) { event.failure = 'refusal'; throw new Error('LLM completion included a refusal'); }
          if (typeof message?.content !== 'string') { event.failure = 'provider-error'; throw new Error('LLM completion had no string message content'); }
          let parsed: unknown;
          try { parsed = JSON.parse(stripFences(message.content)); }
          catch {
            event.failure = 'invalid-json'; event.valid = false;
            if (correcting) throw new Error(`LLM ${args.label}: unparseable JSON after retry`);
            correcting = true;
            continue;
          }
          try { const result = args.schema.parse(parsed); event.valid = true; return result; }
          catch (error) { event.failure = 'schema-error'; event.valid = false; throw error; }
        } catch (error) {
          if (controller.signal.aborted) {
            event.failure = controller.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancel';
          } else if (!event.failure) {
            event.failure = error instanceof OpenRouterError && [400, 404, 422].includes(error.statusCode) ? 'unsupported-strict' : 'provider-error';
          }
          retryTransport = !controller.signal.aborted && error instanceof OpenRouterError && error.statusCode >= 500 && error.statusCode < 600 && attempt + 1 < (this.deps.maxAttempts ?? Number.POSITIVE_INFINITY);
          if (!retryTransport) throw normalizeOpenRouterError(error);
          transportError = error;
        } finally {
          event.finishedAt = new Date().toISOString();
          this.deps.onAttempt?.(event);
        }
        if (retryTransport) {
          const interval = Math.min(retryAfterMs(transportError as OpenRouterError) ?? RETRY_INITIAL_INTERVAL_MS * Math.pow(retryIndex++, RETRY_EXPONENT) + Math.random() * 1000, RETRY_MAX_INTERVAL_MS);
          await waitForRetry(interval, controller.signal);
        }
      }
    })();
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

}

function finiteUsage(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function retryAfterMs(error: OpenRouterError): number | undefined {
  const millisecondsHeader = error.headers.get('retry-after-ms');
  if (millisecondsHeader) {
    const milliseconds = Number(millisecondsHeader);
    if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
  }
  const header = error.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  const secondsMs = seconds * 1000;
  if (Number.isFinite(seconds) && Number.isFinite(secondsMs) && secondsMs > 0) return secondsMs;
  const retryDate = Date.parse(header);
  if (!Number.isFinite(retryDate)) return undefined;
  const remainingMs = retryDate - Date.now();
  return Number.isFinite(remainingMs) && remainingMs > 0 ? remainingMs : undefined;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Zod v4's converter handles ordinary schemas; explicit metadata is used for refined domain outputs. */
function withoutMetaSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _meta, ...providerSchema } = schema;
  return providerSchema;
}
