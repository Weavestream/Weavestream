import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { problemMessage } from '@weavestream/shared';
import { getResolvedClientIp } from '../client-ip';
import { API_INTERNAL_URL, SESSION_COOKIE_NAME } from '../api-config';
import { ApiUnavailableError, RateLimitedError } from '../api-errors';

// Server-side transport for RSC pages, layouts, and `generateMetadata`:
// cookie and client-IP forwarding, the cold-boot retry schedule, response
// classification, and the error-boundary helpers built on it. Domain
// clients (`domains.ts`, `tickets.ts`, and those still in `../server-api.ts`)
// build on `serverApiFetch` and never call `fetch` against the API themselves.

/**
 * Recognizes the handful of Node `fetch` / undici errors that indicate the
 * API container simply isn't reachable yet (or was just restarted). These
 * are transient during `pnpm dev` cold-boot: tsc-watch finishes building
 * `apps/web` a second or two before `apps/api` binds its port, so the
 * first SSR request after a restart hits `ECONNREFUSED`.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const cause = (err as { cause?: unknown }).cause as
    | { code?: string; errors?: Array<{ code?: string }> }
    | undefined;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_SOCKET' ||
    (err as Error).name === 'AbortError'
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse an HTTP `Retry-After` / `retry-after-global` header value.
 * Throttler emits raw seconds (e.g. `"59841"` ms from `@nestjs/throttler`'s
 * debug variant, or `"60"` from the standard one) so we only need to
 * handle the numeric form — HTTP-date variants are not produced by our
 * stack. Returns seconds ≥ 0 or `undefined` when the header is absent
 * or unparseable.
 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  // `@nestjs/throttler` emits milliseconds on the global header in some
  // versions (5-digit values > 1000 are implausible as seconds — that's
  // >16 minutes). If the value looks like a millisecond count convert it.
  if (n > 1000) return Math.ceil(n / 1000);
  return n;
}

export type ServerApiResponse<T> = {
  ok: boolean;
  status: number;
  data: T | null;
  problem?: unknown;
  /**
   * True when `ok === false` and the failure was a network-level error
   * (API container not reachable), as opposed to an HTTP-level error the
   * API actually responded to (4xx/5xx). Callers that degrade gracefully
   * for 401/404 but need to hard-fail on a down backend branch on this.
   */
  networkError?: boolean;
  /**
   * Honoured cooldown in seconds when `status === 429`, derived from
   * the `retry-after` and `retry-after-global` response headers
   * (`@nestjs/throttler` emits both). Always ≥ 1 when present so the
   * countdown UI never renders "retry in 0s". `undefined` for every
   * non-429 response.
   */
  retryAfterSeconds?: number;
};

/**
 * Canonical helper for "I expect a resource, show the right error
 * otherwise" branches in RSC pages. Call it with a `ServerApiResponse`
 * that should have a non-null `data` and it:
 *
 *   - returns the unwrapped `data` when the call succeeded,
 *   - renders the Next.js 404 page for genuine `404` and other client-
 *     meaningful not-found states (no `data` on a 2xx),
 *   - throws `RateLimitedError` on HTTP 429 so the nearest `error.tsx`
 *     boundary can render a cool-down banner (the old pattern masked
 *     these as 404s, which is why the Docker debug chase was so
 *     confusing),
 *   - throws `ApiUnavailableError` on network-level failures so the
 *     same boundary can render "backend unreachable" instead of a
 *     misleading empty page.
 *
 * Authentication (401) is intentionally left to the outer layout
 * guards: by the time an inner page calls this helper, those have
 * already redirected to `/login` on null `me`, so a 401 here almost
 * always means "session dropped mid-render" and mapping it to
 * `notFound()` is fine.
 */
export function throwUnlessFound<T>(
  res: ServerApiResponse<T>,
  path: string,
): T {
  if (res.ok && res.data != null) return res.data;
  if (res.status === 429) {
    // We let Next's error boundary render this — matches the UX
    // pattern we use for `ApiUnavailableError` today.
    throw new RateLimitedError(
      path,
      'GET',
      res.retryAfterSeconds ?? 30,
      extractProblemTitle(res.problem) ?? 'Rate limited',
    );
  }
  // 429 is matched above, so `status >= 500` here only catches real
  // API/proxy 5xx — the backend answering "I'm broken" is the same
  // user-facing situation as not answering at all, and rendering it
  // as a 404 would be just as misleading as the login bounce was.
  if (res.networkError || res.status >= 500) {
    throw new ApiUnavailableError(
      path,
      'GET',
      problemMessage(res.problem) ?? `HTTP ${res.status}`,
    );
  }
  // Anything else — 404, 403, a 2xx with an empty body — is rendered
  // as the Next.js 404 page. `notFound()` throws a tagged error that
  // Next's router uses to render `not-found.tsx`.
  notFound();
}

function extractProblemTitle(problem: unknown): string | undefined {
  if (problem && typeof problem === 'object' && 'title' in problem) {
    const t = (problem as { title?: unknown }).title;
    if (typeof t === 'string' && t.length > 0) return t;
  }
  return undefined;
}

export async function serverApiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<ServerApiResponse<T>> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    // Server Component fetches cannot forward Set-Cookie back to the
    // browser, so never let an SSR read silently rotate the long-lived
    // refresh cookie. `proxy.ts` (`shouldPreflightAuth`) refreshes before
    // protected page renders when the short-lived access cookie is missing.
    .filter((c) => c.name !== SESSION_COOKIE_NAME)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const outgoing = new Headers(init.headers);
  if (!outgoing.has('Accept')) outgoing.set('Accept', 'application/json');
  if (cookieHeader) outgoing.set('cookie', cookieHeader);

  // Forward a single sanitized `X-Forwarded-For` entry to the API.
  // `proxy.ts` already resolved the real client IP from the inbound
  // chain using `TRUST_PROXY_HOPS` and stashed it on the request
  // headers; we pass only that one entry through so an attacker who
  // controls the inbound XFF can't spoof their apparent IP for the
  // API's rate-limit, lockout, IP-rule, and audit code paths. The
  // API trusts XFF only when the TCP peer is on the private docker
  // bridge — see `apps/api/src/main.ts`. `headers()` throws outside
  // a request scope (scripts / build), which we catch and ignore.
  try {
    const incoming = await headers();
    const resolvedIp = getResolvedClientIp(incoming);
    outgoing.set('x-forwarded-for', resolvedIp);
    const proto = incoming.get('x-forwarded-proto');
    if (proto) outgoing.set('x-forwarded-proto', proto);
    const host = incoming.get('x-forwarded-host') ?? incoming.get('host');
    if (host) outgoing.set('x-forwarded-host', host);
  } catch {
    // outside of a request context — nothing to forward
  }

  // Retry schedule tuned to ride out a typical `pnpm dev` cold boot, where
  // the web server starts serving requests ~3-5s before `apps/api` binds
  // its port. Total budget ~5.3s (200 + 400 + 800 + 1500 + 2400 ms) across
  // 6 attempts. In production this only kicks in during genuine outages,
  // and we'd rather the first request take a few seconds than 500 the page.
  // Only safe methods retry — never re-fire a mutation.
  const method = (init.method ?? 'GET').toUpperCase();
  const isSafeMethod = method === 'GET' || method === 'HEAD';
  const backoffMs = isSafeMethod ? [0, 200, 400, 800, 1500, 2400] : [0];
  const maxAttempts = backoffMs.length;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(backoffMs[attempt] ?? 2400);
    try {
      const res = await fetch(`${API_INTERNAL_URL}/api/v1${path}`, {
        ...init,
        headers: outgoing,
        cache: 'no-store',
      });
      const contentType = res.headers.get('content-type') ?? '';
      let data: T | null = null;
      let problem: unknown;
      if (contentType.includes('problem+json')) {
        problem = await res.json().catch(() => null);
      } else if (contentType.includes('json')) {
        // Successful responses carry the resource payload in the body.
        // Non-OK responses with a plain `application/json` body (the
        // NestJS default exception filter, not RFC7807) still contain
        // useful context — surface it as `problem` instead of pinning
        // it on `data`, where call-sites would try to type-cast it.
        if (res.ok) {
          data = (await res.json().catch(() => null)) as T | null;
        } else {
          problem = await res.json().catch(() => null);
        }
      }
      // `retry-after-global` is set by `@nestjs/throttler` when the
      // app-wide limit is the one that tripped; the per-endpoint
      // `retry-after` is set when a route-level throttler wins. We take
      // the larger of the two because requesting again before the longer
      // cooldown elapses will just bounce off the same 429 again.
      let retryAfterSeconds: number | undefined;
      if (res.status === 429) {
        const perBucket = parseRetryAfter(res.headers.get('retry-after'));
        const global = parseRetryAfter(
          res.headers.get('retry-after-global'),
        );
        const longest = Math.max(perBucket ?? 0, global ?? 0);
        retryAfterSeconds = longest > 0 ? Math.ceil(longest) : 30;
      }
      return {
        ok: res.ok,
        status: res.status,
        data,
        problem,
        retryAfterSeconds,
      };
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === maxAttempts - 1) break;
    }
  }

  // All retries exhausted (or a non-retryable error). Log once so real
  // outages stay visible, and return a synthetic failure flagged with
  // `networkError: true` so hard-fail callers (getMe, getSettings) can
  // distinguish "API is down" from "API returned 401/404".
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.warn(
    `[server-api] ${method} ${path} failed after ${maxAttempts} attempt(s): ${message}`,
  );
  return {
    ok: false,
    status: 503,
    data: null,
    networkError: true,
    problem: {
      type: 'about:blank',
      title: 'API unreachable',
      status: 503,
      detail: message,
      networkError: true,
    },
  };
}

/**
 * For `generateMetadata` only. Metadata streams separately from the page
 * render in the App Router, so a throw here can fail the whole response
 * instead of landing in the segment's `error.tsx` — metadata must
 * degrade (title falls back) rather than throw. Nothing is silenced
 * overall: the page render performs the same fetches (deduped by
 * `cache()`) and surfaces the same error through the boundary.
 *
 * Only the two API-availability errors are swallowed; `notFound()` /
 * `redirect()` control-flow throws and genuine bugs still propagate.
 */
export async function forMetadata<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiUnavailableError || err instanceof RateLimitedError) {
      return null;
    }
    throw err;
  }
}
