/** Typed fetch wrapper shared by every *arr/Prowlarr client (DI: no singletons). */

export class ApiError extends Error {
  constructor(
    /** HTTP status; 0 means the request never completed (network error or timeout). */
    readonly status: number,
    readonly url: string,
    /** Raw response body (or the underlying error message when status is 0). */
    readonly body: string,
    /** Parsed Retry-After in seconds, when the server sent one (I5). */
    readonly retryAfter?: number,
  ) {
    super(
      `HTTP ${status} ${url}` + (retryAfter !== undefined ? ` (retry after ${retryAfter}s)` : ''),
    );
    this.name = 'ApiError';
  }
}

export interface HttpDeps {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout; *arr/Prowlarr can be slow on cold searches. */
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean;
/** Array values serialize as repeated plain keys (`k=1&k=2`) — verified binding for Prowlarr search params. */
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

const DEFAULT_TIMEOUT_MS = 15_000;

/** Parses Retry-After as delay-seconds or HTTP-date; undefined when absent/unparseable. */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

export class Http {
  private readonly timeoutMs: number;

  constructor(private readonly deps: HttpDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** GET path with apikey auth; returns parsed JSON; throws ApiError on failure. */
  async getJson<T = unknown>(path: string, params?: QueryParams): Promise<T> {
    return this.request<T>('GET', path, params, undefined);
  }

  /** POST path with a JSON body; returns parsed JSON; throws ApiError on failure. */
  async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, undefined, body);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params: QueryParams | undefined,
    body: unknown,
  ): Promise<T> {
    // String concat, not new URL(): a baseUrl path prefix must survive.
    const base = this.deps.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        for (const v of Array.isArray(value) ? value : [value]) {
          url.searchParams.append(key, String(v));
        }
      }
    }

    const headers: Record<string, string> = {
      'X-Api-Key': this.deps.apiKey,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // status 0: the request never got a response (timeout/DNS/refused).
      throw new ApiError(0, url.toString(), String(cause));
    }

    let text: string;
    try {
      text = await res.text();
    } catch (cause) {
      // Body read failed or the timeout aborted mid-body: we never had a complete response.
      throw new ApiError(0, url.toString(), String(cause));
    }
    if (!res.ok) {
      throw new ApiError(
        res.status,
        url.toString(),
        text,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(res.status, url.toString(), `invalid JSON body: ${text.slice(0, 200)}`);
    }
  }
}
