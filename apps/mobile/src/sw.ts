/// <reference lib="webworker" />
import { clientsClaim, copyResponse } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import {
  createNavigationHandler,
  createWarmCanonical,
  type NavDeps,
} from './lib/sw-nav';

/**
 * The mobile PWA's service worker (Phase 3; navigation path rebuilt in
 * Phase 5a). Compiled by vite-plugin-pwa's `injectManifest` into
 * `/m/sw.js`, scope `/m/`.
 *
 * ## What it caches — and the invariant that matters more
 *
 *  - PRECACHE: content-hashed build assets (js/css/woff2) only. Never
 *    HTML — `dist/index.html` carries the `__WS_ACCENT__` placeholder;
 *    the real shell is accent-substituted per request by the Next
 *    route handler.
 *  - RUNTIME: `/m/*` navigation responses (the shell), network-first —
 *    online always gets the fresh `no-store` shell and offline serves
 *    the last one — plus one pinned canonical copy of `/m/app` in its
 *    own cache, refreshed by every successful HTML navigation, which
 *    the fallback ladder serves so ANY deep link boots the SPA offline
 *    (the client router resolves the path).
 *
 *  - **`/api/*` has NO route — deliberately.** A request matching no
 *    route and no precache entry is never intercepted by Workbox, so
 *    this worker structurally cannot cache, buffer, or delay
 *    credential-bearing traffic or the Ask anything SSE stream.
 *    Reveal/detail responses must never touch disk (CLAUDE.md); do not
 *    add an /api route here, not even NetworkOnly.
 *
 * ## Deadlines — the Phase 5a P0 fix
 *
 * WebKit offline fetches can STALL instead of rejecting, and a stalled
 * navigation used to hang forever: Workbox's NetworkFirst only falls
 * back on rejection, and it holds the fetch event's lifetime open until
 * its network promise settles — which also blocks a waiting worker from
 * activating (the deploy-update path). The navigation route is now a
 * hand-rolled network-first handler (`lib/sw-nav.ts`) that ABORTS its
 * fetch at a deadline and owns the complete fallback ladder (exact
 * shell → canonical → network error). The install warm and the
 * background cache writes carry their own deadlines, so **every
 * event-lifetime promise this worker registers settles in bounded
 * time** — deploy-update correctness depends on that invariant; keep it
 * when touching anything here.
 *
 * Bare `/m` is NOT matched: registration scope is `/m/`, and `/m` (no
 * slash) is outside it, so such a navigation never reaches this worker.
 * Online it 308s to `/m/app`; offline it fails — an accepted limitation
 * for pre-`start_url` bookmarks. Never widen the scope: `/m` is a
 * string prefix that would also capture `/me` and `/mfa/*`.
 *
 * ## Cache lifecycle
 *
 * Cache names are versioned by a fingerprint of the injected precache
 * manifest, so an INSTALLING worker never touches the ACTIVE worker's
 * caches: install populates only the new version's canonical cache
 * (and a failed warm rejects install, keeping the old worker fully in
 * service); activate deletes the previous version's caches. The shell
 * cache is FIFO-trimmed by entry count — the old 30-day age cap went
 * with ExpirationPlugin (entries refresh on every successful
 * navigation; offline, a month-old shell beats an error page; caches
 * rotate wholesale per worker version anyway). Rollback story: publish
 * once with vite-plugin-pwa's `selfDestroying: true` to unregister
 * fleet-wide.
 */

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

// The literal `self.__WB_MANIFEST` token below is the injection point
// workbox-build scans the COMPILED output for — never alias it behind
// another identifier or the build fails with "unable to find a place
// to inject the manifest".
const manifest = self.__WB_MANIFEST;

/** Stable per-build discriminator — not cryptographic, just distinct. */
function fingerprint(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Stamped by `scripts/emit-to-web.mjs` at publish time (a hash of this
 * file's own compiled bytes). The manifest fingerprint alone is NOT a
 * sufficient version: an SW-code-only deploy changes the worker without
 * changing the precache manifest, and the installing worker would then
 * warm into the ACTIVE worker's same-named canonical cache — mutating
 * the live offline fallback before its own activation succeeded. The
 * stamp makes cache versions track the worker itself. Unstamped (a raw
 * `vite build`, dev preview) the placeholder still yields a stable VER.
 */
const BUILD_ID = '__WS_SW_BUILD__';

const VER = fingerprint(`${BUILD_ID}:${JSON.stringify(manifest)}`);
const SHELL_CACHE = `ws-m-shell-${VER}`;
const CANONICAL_CACHE = `ws-m-canonical-${VER}`;
const CANONICAL_URL = '/m/app';

// The explicit options stop Workbox's directory-index defaults
// (`index.html`) from ever mattering — no HTML is precached, and no
// URL may quietly resolve to one. `null` is how the runtime disables
// directoryIndex (only `undefined` re-applies the default); the type
// admits only string, hence the cast.
precacheAndRoute(manifest, {
  directoryIndex: null as unknown as string,
  cleanURLs: false,
});
cleanupOutdatedCaches();

/**
 * Real-global wiring for the deadline-bounded navigation/warm logic.
 * `credentials: 'include'` on every shell fetch so the `ws_ui` cookie
 * picks the right theme + accent variant. Failures log to the SW
 * console — the page cannot observe a failed install through
 * registration callbacks alone (main.tsx watches the `redundant`
 * transition as its half of the signal).
 */
const navDeps: NavDeps = {
  fetchFn: (url, init) => fetch(url, init),
  openCache: (name) => caches.open(name),
  copyResponse,
  shellCacheName: SHELL_CACHE,
  canonicalCacheName: CANONICAL_CACHE,
  canonicalUrl: CANONICAL_URL,
  expectedOrigin: self.location.origin,
  log: (msg, err) =>
    err === undefined
      ? console.error(`[m-sw] ${msg}`)
      : console.error(`[m-sw] ${msg}`, err),
};

/**
 * Deadline-bounded END TO END (fetch, validation, redirect
 * normalization, cache.put) — a stalled warm used to wedge install
 * forever, silently blocking every future worker update. Throws on any
 * failure; callers decide whether that is fatal (install) or a
 * keep-the-old-copy no-op (message re-warm).
 */
const warmCanonical = createWarmCanonical(navDeps);

/**
 * Install: warm THIS version's canonical shell. A failed warm REJECTS
 * install — activation deletes the previous version's caches, so
 * proceeding with an empty canonical would strip a working offline
 * installation and claim clients with no fallback. The browser retries
 * install on a later update check.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(warmCanonical());
});

/**
 * Re-warm on demand. The pinned copy otherwise refreshes only at
 * install or on a successful HTML navigation — an in-app appearance
 * change is neither, so without this an immediately-offline restart
 * would boot the old-stamped theme until JS corrects it. ui-prefs.ts
 * posts this after a successful preference apply. Failure (offline,
 * storage pressure) keeps the previous copy — same degradation as the
 * navigation-refresh path.
 */
self.addEventListener('message', (event) => {
  // Origin gate. Unlike a window's `message` handler, a service worker
  // is reachable ONLY from same-origin clients — `navigator.service
  // Worker` is same-origin, so a cross-origin document can never get a
  // handle to this registration — which makes `event.origin`
  // structurally our own origin and this check unable to reject a real
  // message. It is here as defence in depth and because CodeQL's
  // js/missing-origin-check does not model ServiceWorkerGlobalScope
  // (alert #33). An absent origin is tolerated rather than dropped: the
  // failure mode is a silently stale offline theme, and the check
  // guards nothing a same-origin-only channel had exposed anyway.
  if (event.origin !== '' && event.origin !== self.location.origin) {
    return;
  }
  if ((event.data as { type?: string } | null)?.type !== 'refresh-canonical') {
    return;
  }
  event.waitUntil(
    warmCanonical().catch(() => {
      /* keep the previous pinned copy */
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              (name.startsWith('ws-m-shell-') ||
                name.startsWith('ws-m-canonical-')) &&
              name !== SHELL_CACHE &&
              name !== CANONICAL_CACHE,
          )
          .map((name) => caches.delete(name)),
      );
    })(),
  );
});

void self.skipWaiting();
clientsClaim();

/**
 * Every `/m/*` navigation goes through the deadline-bounded
 * network-first handler: online serves (and re-pins) the fresh shell;
 * a rejected OR STALLED fetch falls back to the exact-URL shell entry,
 * then the pinned canonical, then a network error — the handler owns
 * that whole ladder and never throws. (Bare `/m` is deliberately not
 * matched — it is outside the `/m/` registration scope and can never
 * reach this worker; see the header doc.)
 */
registerRoute(
  ({ request, url }) =>
    request.mode === 'navigate' && url.pathname.startsWith('/m/'),
  createNavigationHandler(navDeps),
);

/**
 * Backstop only. The navigation handler above never throws — it owns
 * its complete fallback ladder — so this terminates nothing but a
 * failed precache/asset route, exactly as a plain network error would.
 */
setCatchHandler(async () => Response.error());
