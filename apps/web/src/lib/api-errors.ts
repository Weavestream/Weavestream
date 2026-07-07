import type { ServerApiResponse } from './server-api';

/**
 * Client-safe error taxonomy for server-side API fetches.
 *
 * Lives outside `server-api.ts` because that module imports
 * `next/headers` and can therefore never be pulled into a client
 * component — but `app/error.tsx` (a client boundary) needs the digest
 * constants and parsers below to recognize these errors in production.
 * Keeping both sides on one module replaces the old "keep the prefix
 * in sync with error.tsx" comment-contract with a real import.
 *
 * Nothing here may import server-only modules; the `server-api` import
 * above is type-only and erased at compile time.
 */

/**
 * Magic `error.digest` value the top-level `error.tsx` boundary matches
 * to render the dedicated "backend unavailable" page. Next.js App
 * Router only forwards `message` and `digest` across the RSC → client
 * boundary in production (everything else on the `Error` instance is
 * stripped as sensitive), so digest is the only reliable channel.
 * Static — the panel needs no out-of-band state, and the value doubles
 * as the non-sensitive `ref:` line users can quote in support requests.
 */
export const API_UNAVAILABLE_DIGEST = 'WS_API_UNAVAILABLE';

/**
 * Magic prefix on `error.digest` that `error.tsx` matches against to
 * render a retry banner instead of the generic "Something went wrong"
 * page. We encode the retry cooldown into the digest because digest is
 * the only channel for out-of-band state (see above).
 */
export const RATE_LIMIT_DIGEST_PREFIX = 'WS_RATE_LIMITED:';

/**
 * Thrown by `getMe`, `throwUnlessFound`, and any other server helper
 * that would otherwise silently return a fallback when the API is
 * genuinely unreachable (ECONNREFUSED, dropped socket, etc.) or
 * answering with 5xx. Surfacing it as an exception lets the nearest
 * `error.tsx` boundary render a dedicated "backend unavailable" page
 * instead of a misleading login redirect, 404, or a random
 * `TypeError: Cannot read properties of null` deep inside the
 * component tree.
 */
export class ApiUnavailableError extends Error {
  readonly path: string;
  readonly method: string;
  override readonly cause?: unknown;
  /** Read by Next's error boundary; see `API_UNAVAILABLE_DIGEST`. */
  readonly digest = API_UNAVAILABLE_DIGEST;
  constructor(path: string, method: string, message: string, cause?: unknown) {
    super(`API unavailable — ${method} ${path}: ${message}`);
    this.name = 'ApiUnavailableError';
    this.path = path;
    this.method = method;
    this.cause = cause;
  }
}

/**
 * Thrown when a server component's read hits the API-level rate
 * limiter (HTTP 429). Separated from generic 4xx / 5xx failures so
 * the nearest `error.tsx` boundary can render a dedicated "please
 * slow down" banner instead of the misleading 404 the old "return
 * `notFound()` on any non-OK" pattern used to produce.
 *
 * `retryAfterSeconds` is the honoured cooldown — the server-side
 * throttler returns it in the `retry-after` header (per-bucket) and
 * in a `retry-after-global` header for the app-wide limit; we pick
 * the larger of the two so the UI countdown actually matches what
 * the next request will see.
 */
export class RateLimitedError extends Error {
  readonly path: string;
  readonly method: string;
  readonly retryAfterSeconds: number;
  /** Read by Next's error boundary; see `RATE_LIMIT_DIGEST_PREFIX`. */
  readonly digest: string;
  constructor(
    path: string,
    method: string,
    retryAfterSeconds: number,
    message = 'Rate limited',
  ) {
    super(`${message} — ${method} ${path} (retry in ${retryAfterSeconds}s)`);
    this.name = 'RateLimitedError';
    this.path = path;
    this.method = method;
    this.retryAfterSeconds = retryAfterSeconds;
    this.digest = `${RATE_LIMIT_DIGEST_PREFIX}${retryAfterSeconds}`;
  }
}

/**
 * Parses the cooldown out of a `WS_RATE_LIMITED:<seconds>` digest.
 * Returns `null` for non-rate-limit digests; falls back to 30s when
 * the suffix is unparseable or implausible so the countdown UI never
 * renders "retry in 0s".
 */
export function parseRateLimitDigest(digest: string | undefined): number | null {
  if (!digest) return null;
  if (!digest.startsWith(RATE_LIMIT_DIGEST_PREFIX)) return null;
  const n = Number.parseInt(digest.slice(RATE_LIMIT_DIGEST_PREFIX.length), 10);
  if (!Number.isFinite(n) || n < 1) return 30;
  return n;
}

export function isApiUnavailableDigest(digest: string | undefined): boolean {
  return digest === API_UNAVAILABLE_DIGEST;
}

/**
 * Pure classification shared by the null-returning read helpers in
 * `server-api.ts` (`getMe`, `getAsset`, `getSubnetDetail`,
 * `listLayouts`, …):
 *
 *   - 2xx with a body → the payload;
 *   - network-level failure (the synthetic 503 `serverApiFetch` emits
 *     after its retry budget) or a real API/proxy 5xx → throw
 *     `ApiUnavailableError` so the boundary renders the backend-
 *     unavailable page — a backend fault is NOT a missing resource
 *     (or, for `/me`, an auth state);
 *   - 429 → throw `RateLimitedError` for the cooldown banner;
 *   - remaining 4xx (401/403/404) or an empty 2xx body → `null`, and
 *     the caller decides (login redirect for `/me`, `notFound()` for
 *     resource reads).
 *
 * Exported for unit tests; extracted here so it stays testable without
 * dragging in `next/headers`.
 */
export function unwrapApiResponse<T>(
  res: ServerApiResponse<T>,
  path: string,
): T | null {
  if (res.ok && res.data != null) return res.data;
  if (res.networkError || res.status >= 500) {
    throw new ApiUnavailableError(path, 'GET', `HTTP ${res.status}`);
  }
  if (res.status === 429) {
    throw new RateLimitedError(path, 'GET', res.retryAfterSeconds ?? 30);
  }
  return null;
}

/** `/me`-specific alias of {@link unwrapApiResponse}, used by `getMe`. */
export function unwrapMeResponse<T>(res: ServerApiResponse<T>): T | null {
  return unwrapApiResponse(res, '/me');
}
