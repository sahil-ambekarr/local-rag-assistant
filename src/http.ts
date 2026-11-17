export type FetchLike = typeof fetch;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  /** Called before each wait; lets callers log the retry. */
  onRetry?: (attempt: number, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Network failures, timeouts, 429 and 5xx are worth retrying; other 4xx are caller bugs. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof TimeoutError) return true;
  if (err instanceof Error && err.name === 'AbortError') return false;
  return err instanceof TypeError; // fetch() rejects with TypeError on connection failure
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries with exponential backoff (base, 2x, 4x ...). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.retries || !isRetryable(err)) throw err;
      opts.onRetry?.(attempt + 1, err);
      await sleep(base * 2 ** attempt);
    }
  }
}

export interface TimedRequest {
  timeoutMs: number;
  /** Caller cancellation (e.g. the browser closed the SSE connection). */
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

/**
 * fetch() with a hard timeout. The timeout covers the whole exchange including
 * reading a streamed body, because the same signal stays attached to the response.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, req: TimedRequest): Promise<Response> {
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
  const doFetch = req.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal });
  } catch (err) {
    if (timeout.aborted) throw new TimeoutError(`Request to ${url} timed out after ${req.timeoutMs} ms`);
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status, `${init.method ?? 'GET'} ${url} failed with ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}
