// Same-origin JSON client with timeouts and the SPEC 3 error shape.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | null;

  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Public lists pass 'default' so the server's Cache-Control applies. Everything else stays out of the HTTP cache. */
  cache?: RequestCache;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** The largest answer is 500 admin rows with appeal texts of 2,000 characters, far below this. */
const MAX_BODY_CHARS = 4_000_000;

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
}

function errorFromBody(status: number, body: unknown, retryAfter: number | null): ApiError {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error;
    if (err && typeof err === 'object') {
      const { code, message } = err as { code?: unknown; message?: unknown };
      if (typeof code === 'string' && typeof message === 'string') {
        return new ApiError(status, code.slice(0, 64), message.slice(0, 300), retryAfter);
      }
    }
  }
  return new ApiError(status, `http_${status}`, `The server answered with status ${status}.`, retryAfter);
}

function connectionError(err: unknown): ApiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') return new ApiError(0, 'timeout', 'The xslop server did not answer in time.');
  if (err instanceof DOMException && err.name === 'AbortError') return new ApiError(0, 'aborted', 'The request was cancelled.');
  return new ApiError(0, 'network', 'The xslop server could not be reached.');
}

/** A `//` test is not enough: the URL parser reads `\` as `/` and drops tabs and newlines, so `/\host` leaves the origin. */
const isSameOriginPath = (path: string): boolean => /^\/(?!\/)/.test(path) && !/[\\\t\n\r]/.test(path);

/** Sends a request and returns parsed JSON, or null for 204/304. Throws ApiError on every failure. */
export async function request(path: string, opts: RequestOptions = {}): Promise<unknown> {
  if (!isSameOriginPath(path)) throw new ApiError(0, 'bad_path', 'Only same-origin paths are allowed.');
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
  if (opts.signal) signals.push(opts.signal);
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    cache: opts.cache ?? 'no-store',
    signal: AbortSignal.any(signals),
  };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw connectionError(err);
  }

  if (res.status === 204 || res.status === 304) return null;
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  let body: unknown = null;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const tooLarge = new ApiError(res.status, 'bad_response', 'The server sent a response that is too large.', retryAfter);
    if (Number(res.headers.get('content-length')) > MAX_BODY_CHARS) throw tooLarge;
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw connectionError(err);
    }
    if (text.length > MAX_BODY_CHARS) throw tooLarge;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'bad_response', 'The server sent a response that could not be read.', retryAfter);
    }
  }
  if (!res.ok) throw errorFromBody(res.status, body, retryAfter);
  if (body === null) throw new ApiError(res.status, 'bad_response', 'The server sent an empty response.');
  return body;
}

export function badShape(what: string): ApiError {
  return new ApiError(200, 'bad_response', `The server sent ${what} in an unexpected shape.`);
}
