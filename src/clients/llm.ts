import { z } from 'zod';
import type { OpenRouter } from '@openrouter/sdk';
import { OpenRouterError } from '@openrouter/sdk/models/errors';
import { ApiError } from '../http';

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
    },
  ) {}

  async json<T>(args: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    label: string;
    jsonSchema?: { name: string; schema: Record<string, unknown> };
  }): Promise<T> {
    const controller = new AbortController();
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
      for (let attempt = 0; ; attempt++) {
        const content = await this.complete(
          args.system,
          args.user,
          args.schema,
          args.jsonSchema,
          attempt > 0,
          controller.signal,
        );
        try {
          const parsed = JSON.parse(stripFences(content)) as unknown;
          return args.schema.parse(parsed);
        } catch (e) {
          if (e instanceof z.ZodError) {
            throw e; // zod failure at the LLM boundary (I8): no retry.
          }
          const last = e instanceof Error ? e : undefined;
          if (attempt === 1) {
            throw new Error(
              `LLM ${args.label}: unparseable JSON after retry: ${last?.message ?? String(e)}`,
            );
          }
        }
      }
    })();
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  }

  private async complete(
    system: string,
    user: string,
    schema: z.ZodType<unknown>,
    jsonSchema: { name: string; schema: Record<string, unknown> } | undefined,
    correcting: boolean,
    signal: AbortSignal,
  ): Promise<string> {
    const generatedSchema = jsonSchema?.schema ?? withoutMetaSchema(z.toJSONSchema(schema));
    let completion: Awaited<ReturnType<OpenRouter['chat']['send']>>;
    try {
      completion = await this.sendWithRetry({
        model: this.deps.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
          ...(correcting
            ? [{
                role: 'user' as const,
                content: 'Correction: Return only a JSON value that conforms to the requested JSON Schema. Do not include prose, markdown, or explanations.',
              }]
            : []),
        ],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: jsonSchema?.name ?? 'llm_output',
            strict: true,
            schema: generatedSchema,
          },
        },
        provider: { requireParameters: true },
      }, signal);
    } catch (error) {
      throw normalizeOpenRouterError(error);
    }
    if (completion instanceof ReadableStream) {
      throw new Error('LLM returned a stream; non-streaming completion required');
    }
    const message = completion.choices[0]?.message;
    if (typeof message?.refusal === 'string' && message.refusal.trim() !== '') {
      throw new Error('LLM completion included a refusal');
    }
    const content = message?.content;
    if (typeof content !== 'string') {
      throw new Error('LLM completion had no string message content');
    }
    return content;
  }

  /** Retry recognized SDK 5xx errors with bounded, abortable backoff. */
  private async sendWithRetry(
    chatRequest: Parameters<OpenRouter['chat']['send']>[0]['chatRequest'],
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<OpenRouter['chat']['send']>>> {
    const startedAt = Date.now();
    let retryIndex = 0;
    for (;;) {
      if (signal.aborted) throw signal.reason;
      try {
        // The SDK's backoff sleeps cannot be aborted. Keep its configured retry
        // behavior for recognized HTTP errors here so the JSON deadline also bounds waits.
        return await this.deps.client.chat.send({ chatRequest }, {
          signal,
          retries: { strategy: 'none' },
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (!(error instanceof OpenRouterError) || error.statusCode < 500 || error.statusCode >= 600) {
          throw error;
        }
        // Match the SDK's maxElapsedTime check: stop once a failed attempt returns
        // after the configured window; the enclosing deadline is the hard bound.
        if (Date.now() - startedAt > JSON_DEADLINE_MS) throw error;
        const interval = Math.min(
          retryAfterMs(error) ?? RETRY_INITIAL_INTERVAL_MS * Math.pow(retryIndex, RETRY_EXPONENT) + Math.random() * 1000,
          RETRY_MAX_INTERVAL_MS,
        );
        await waitForRetry(interval, signal);
        retryIndex++;
      }
    }
  }
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
