/**
 * Deadline-bounded navigation + canonical-warm logic for the mobile
 * service worker (Phase 5a A1).
 *
 * Why this exists as its own workbox-free module: WebKit offline fetches
 * can STALL instead of rejecting, and Workbox's NetworkFirst cannot be
 * bounded from outside — it ignores `fetchOptions` for navigation
 * requests (no abort signal can reach the fetch) and it extends the
 * fetch event's lifetime until its own done-promise settles, so a
 * raced-but-hung network promise pins the event open and can hold up
 * activation of a waiting worker (the deploy-update path). The route
 * must therefore own its network attempt, abort it at a deadline, and
 * keep every lifetime-extension it registers bounded as well.
 *
 * Everything here is dependency-injected (fetch, caches, workbox's
 * `copyResponse`) so the logic unit-tests under plain Node with no
 * webworker types and no workbox imports in the test graph. `sw.ts`
 * wires the real globals.
 */

/** Abort the navigation network attempt and fall back to caches. */
export const NAV_DEADLINE_MS = 5000;
/** Bounds the ENTIRE install warm transaction (fetch through cache.put). */
export const WARM_DEADLINE_MS = 10_000;
/** Bounds the background shell/canonical cache writes after a response. */
export const PIN_DEADLINE_MS = 10_000;
/** FIFO cap on per-URL shell entries (replaces workbox ExpirationPlugin). */
export const SHELL_MAX_ENTRIES = 24;

/** Structural slice of FetchEvent — keeps webworker types out of here. */
export interface NavEvent {
  waitUntil(p: Promise<unknown>): void;
}

export interface NavDeps {
  fetchFn: (
    url: string,
    init: { signal: AbortSignal; credentials: 'include' },
  ) => Promise<Response>;
  openCache: (name: string) => Promise<Cache>;
  /** workbox-core's copyResponse: re-creates a Response without the
   *  `redirected` flag (a redirected Response is a spec-level network
   *  error when served to a navigation). */
  copyResponse: (r: Response) => Promise<Response>;
  shellCacheName: string;
  canonicalCacheName: string;
  /** Cache key AND warm target path, e.g. '/m/app'. */
  canonicalUrl: string;
  /** self.location.origin — redirect targets must stay on it. */
  expectedOrigin: string;
  log: (msg: string, err?: unknown) => void;
}

export function isHtmlResponse(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/html');
}

/**
 * Resolve when `work` settles or at `ms`, whichever is first — the
 * bounded wrapper is what goes into `event.waitUntil`, so a stalled
 * cache write can never pin the event open. A rejection of `work` is
 * ALWAYS logged, whether it lands before the deadline (the wrapper
 * still resolves — bounded, but never silent) or after it (observed
 * straggler, never an unhandled rejection).
 */
export function settleWithin(
  work: Promise<unknown>,
  ms: number,
  log: NavDeps['log'],
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, ms);
    work.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      },
      (err: unknown) => {
        log('background cache write failed', err);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      },
    );
  });
}

/**
 * Mirror `work`, but reject at `ms` if it hasn't settled — after
 * running `onTimeout` (the fetch abort; a no-op when the fetch already
 * resolved, since a stalled Cache.put cannot be cancelled, only
 * disowned). A post-deadline settlement of the disowned `work` is
 * observed and logged, never unhandled.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void,
  log: NavDeps['log'],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        // The abort must never mask the deadline rejection itself.
      }
      work.then(
        () => log('disowned work settled after its deadline'),
        (err: unknown) => log('disowned work failed after its deadline', err),
      );
      reject(new Error(`deadline of ${ms}ms exceeded`));
    }, ms);
    work.then(
      (value) => {
        if (settled) return; // late; the observer above already logged
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Redirect validation + normalization, in the order that matters:
 * `response.url` / `response.redirected` are captured BEFORE any copy,
 * because `copyResponse` re-creates the Response with an empty `url`.
 * A redirect is in-scope only if the FINAL URL kept our origin and
 * stayed under `/m/` — anything else must not be served (or pinned) as
 * a body under the original `/m/*` URL.
 */
async function toServable(
  response: Response,
  requestUrl: string,
  deps: NavDeps,
): Promise<
  | { kind: 'ok'; response: Response }
  | { kind: 'off-scope'; finalUrl: string }
> {
  if (!response.redirected) return { kind: 'ok', response };
  const finalUrl = response.url;
  let inScope = false;
  try {
    const target = new URL(finalUrl);
    inScope =
      target.origin === new URL(requestUrl).origin &&
      target.pathname.startsWith('/m/');
  } catch {
    inScope = false; // unparseable/empty final URL: treat as off-scope
  }
  if (!inScope) return { kind: 'off-scope', finalUrl };
  return { kind: 'ok', response: await deps.copyResponse(response) };
}

/** Shell exact URL → pinned canonical → a network-level error the
 *  browser renders as its own error page. The ONE fallback ladder. */
async function respondFromCaches(
  requestUrl: string,
  deps: NavDeps,
): Promise<Response> {
  const shell = await deps.openCache(deps.shellCacheName);
  const exact = await shell.match(requestUrl);
  if (exact) return exact;
  const canonical = await deps.openCache(deps.canonicalCacheName);
  const pinned = await canonical.match(deps.canonicalUrl);
  if (pinned) return pinned;
  return Response.error();
}

/**
 * Canonical first — it is the copy every offline deep link depends on,
 * so if the pin deadline disowns a stalled write, the load-bearing
 * entry is the one most likely to have landed.
 *
 * Both caches are keyed by URL STRING, never the navigation Request:
 * Next stamps `Vary` on the shell response, and string keys are what
 * keep cache matching immune to it (a Request key would compare Vary
 * headers on both sides). Do not re-key.
 */
async function pinShellAndCanonical(
  requestUrl: string,
  forCanonical: Response,
  forShell: Response,
  deps: NavDeps,
): Promise<void> {
  const canonical = await deps.openCache(deps.canonicalCacheName);
  await canonical.put(deps.canonicalUrl, forCanonical);
  const shell = await deps.openCache(deps.shellCacheName);
  await shell.put(requestUrl, forShell);
  const keys = await shell.keys();
  const excess = keys.length - SHELL_MAX_ENTRIES;
  for (let i = 0; i < excess; i += 1) {
    const key = keys[i]; // insertion order — FIFO trim
    if (key) await shell.delete(key);
  }
}

/**
 * Network-first navigation handler with a hard deadline.
 *
 * The fetch goes by URL STRING, not the navigation Request: a
 * navigate-mode Request rejects any non-empty init (the reason Workbox
 * itself passes no fetchOptions there), and fetching by URL is the only
 * way to attach an AbortSignal. Same-origin + `credentials: 'include'`
 * keeps the `ws_ui` cookie so the accent-correct shell variant comes
 * back; the server does not content-negotiate the shell.
 *
 * The timer stays armed through validation/normalization (a stalled
 * BODY read after headers would otherwise hang the handler — the abort
 * rejects in-flight body reads too) and is cleared only once the
 * servable response exists. After `return`, the browser owns the body
 * stream; a mid-body stall there is accepted (same as any pass-through).
 *
 * Every event-lifetime promise this handler registers settles by
 * ~max(NAV_DEADLINE_MS, PIN_DEADLINE_MS); the underlying pin may run on
 * past `settleWithin` opportunistically, observed only. The handler
 * never throws — it owns the complete fallback ladder.
 */
export function createNavigationHandler(
  deps: NavDeps,
): (opts: { request: Request; event: NavEvent }) => Promise<Response> {
  return async ({ request, event }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NAV_DEADLINE_MS);
    try {
      const response = await deps.fetchFn(request.url, {
        signal: controller.signal,
        credentials: 'include',
      });
      if (!response.ok || !isHtmlResponse(response)) {
        clearTimeout(timer);
        return response; // 404/503/non-shell: pass through, never cached
      }
      const outcome = await toServable(response, request.url, deps);
      if (outcome.kind === 'off-scope') {
        clearTimeout(timer);
        // Surface the redirect instead of masking its body under the
        // /m/* URL; the target is outside our scope, so the browser's
        // follow-up navigation is not intercepted. An unparseable
        // finalUrl makes Response.redirect throw → outer catch → ladder.
        return Response.redirect(outcome.finalUrl, 302);
      }
      const servable = outcome.response;
      // Cache.put fully consumes and locks its body — both cache clones
      // are taken BEFORE the served instance leaves this function.
      const forCanonical = servable.clone();
      const forShell = servable.clone();
      clearTimeout(timer);
      event.waitUntil(
        settleWithin(
          pinShellAndCanonical(request.url, forCanonical, forShell, deps),
          PIN_DEADLINE_MS,
          deps.log,
        ),
      );
      return servable;
    } catch {
      clearTimeout(timer);
      return respondFromCaches(request.url, deps);
    }
  };
}

/**
 * Install-time canonical warm, deadline-bounded END TO END — fetch,
 * validation, normalization, and the cache.put. A hung warm used to
 * wedge install forever (blocking every future worker update); now the
 * install-facing promise rejects at WARM_DEADLINE_MS, the browser
 * retries install on a later update check, and the disowned transaction
 * is observed. Failures are logged inside the worker (the page cannot
 * see a failed install through registration callbacks alone).
 */
export function createWarmCanonical(deps: NavDeps): () => Promise<void> {
  return () => {
    const controller = new AbortController();
    const targetUrl = new URL(deps.canonicalUrl, deps.expectedOrigin).toString();
    const work = (async () => {
      const response = await deps.fetchFn(targetUrl, {
        signal: controller.signal,
        credentials: 'include',
      });
      if (!response.ok || !isHtmlResponse(response)) {
        throw new Error(`canonical shell warm failed (${response.status})`);
      }
      const outcome = await toServable(response, targetUrl, deps);
      if (outcome.kind === 'off-scope') {
        throw new Error(
          `canonical warm redirected off-scope (${outcome.finalUrl || 'unknown'})`,
        );
      }
      const cache = await deps.openCache(deps.canonicalCacheName);
      await cache.put(deps.canonicalUrl, outcome.response);
    })();
    return withDeadline(work, WARM_DEADLINE_MS, () => controller.abort(), deps.log).catch(
      (err: unknown) => {
        deps.log('canonical warm failed', err);
        throw err;
      },
    );
  };
}
