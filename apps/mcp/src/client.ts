/**
 * Minimal Weavestream REST client. Every request carries the user's API key,
 * so the server applies exactly the permissions, tenant scope, rate limits and
 * audit it applies to the same call from any other client. This file adds no
 * authority of its own.
 */

export interface ClientConfig {
  /** Origin of the Weavestream instance, e.g. https://weavestream.example.com */
  baseUrl: string;
  /** `ws_<keyId>_<secret>`. Never logged and never included in errors. */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class WeavestreamApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'WeavestreamApiError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Validate configuration up front. The key is a long-lived bearer credential,
 * so it is only ever sent over HTTPS (plain HTTP is allowed for loopback dev).
 */
export function parseConfig(env: Record<string, string | undefined>): ClientConfig {
  const rawUrl = env.WEAVESTREAM_URL?.trim();
  const apiKey = env.WEAVESTREAM_API_KEY?.trim();
  if (!rawUrl) throw new Error('WEAVESTREAM_URL is required.');
  if (!apiKey) throw new Error('WEAVESTREAM_API_KEY is required.');
  if (!/^ws_[0-9a-f]+_[A-Za-z0-9_-]+$/.test(apiKey)) {
    throw new Error('WEAVESTREAM_API_KEY does not look like a Weavestream key (ws_…).');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('WEAVESTREAM_URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error('WEAVESTREAM_URL must use https:// (http:// only for localhost).');
  }
  return { baseUrl: url.origin, apiKey };
}

export class WeavestreamClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`/api/v1${path}`, this.config.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, {
        method,
        redirect: 'error', // never replay the bearer token to another origin
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      // Read the body inside the try: the timeout signal also covers it.
      text = await res.text();
    } catch (err) {
      // Timeouts and network failures become tool errors the model can read.
      const reason =
        err instanceof DOMException && err.name === 'TimeoutError'
          ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : 'could not be reached';
      throw new WeavestreamApiError(0, `Weavestream ${reason}.`);
    }
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      throw new WeavestreamApiError(res.status, describeProblem(res.status, json));
    }
    return json as T;
  }
}

/**
 * Server problem details are safe to surface; never echo request headers.
 * Validation `issues` ({ path, message }) are passed through so the model
 * can correct its arguments instead of retrying blind.
 */
function describeProblem(status: number, json: unknown): string {
  const p = (json ?? {}) as {
    detail?: unknown;
    title?: unknown;
    message?: unknown;
    issues?: unknown;
  };
  const detail = [p.detail, p.message, p.title].find((v) => typeof v === 'string' && v.length > 0);
  const issues = Array.isArray(p.issues)
    ? p.issues
        .slice(0, 20)
        .map(
          (i: { path?: unknown; message?: unknown }) =>
            `${typeof i?.path === 'string' && i.path ? i.path : '(body)'}: ${String(i?.message ?? 'invalid')}`,
        )
        .join('; ')
    : '';
  const hint =
    status === 401
      ? ' The API key is invalid, expired or revoked.'
      : status === 403
        ? ' The key is read-only, its owner lacks permission, or this action needs an interactive session.'
        : '';
  return `Weavestream returned ${status}${detail ? `: ${String(detail)}` : '.'}${issues ? ` Issues: ${issues}.` : ''}${hint}`;
}
