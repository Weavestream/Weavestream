/// <reference lib="webworker" />
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  cleanupOutdatedCaches,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';

/**
 * The mobile PWA's service worker (Phase 3). Compiled by
 * vite-plugin-pwa's `injectManifest` into `/m/sw.js`, scope `/m/`.
 *
 * ## What it caches — and the invariant that matters more
 *
 *  - PRECACHE: content-hashed build assets (js/css/woff2) only. Never
 *    HTML — `dist/index.html` carries the `__WS_ACCENT__` placeholder;
 *    the real shell is accent-substituted per request by the Next
 *    route handler.
 *  - RUNTIME: `/m` navigation responses (the shell), NetworkFirst — so
 *    online always gets the fresh `no-store` shell and offline serves
 *    the last one — plus one pinned canonical copy of `/m/app` in its
 *    own non-expiring cache, refreshed by every successful HTML
 *    navigation, which the catch handler serves so ANY deep link boots
 *    the SPA offline (the client router resolves the path).
 *
 *  - **`/api/*` has NO route — deliberately.** A request matching no
 *    route and no precache entry is never intercepted by Workbox, so
 *    this worker structurally cannot cache, buffer, or delay
 *    credential-bearing traffic or the Ask anything SSE stream.
 *    Reveal/detail responses must never touch disk (CLAUDE.md); do not
 *    add an /api route here, not even NetworkOnly.
 *
 * ## Cache lifecycle
 *
 * Cache names are versioned by a fingerprint of the injected precache
 * manifest, so an INSTALLING worker never touches the ACTIVE worker's
 * caches: install populates only the new version's canonical cache
 * (and a failed warm rejects install, keeping the old worker fully in
 * service); activate deletes the previous version's caches. Rollback
 * story: publish once with vite-plugin-pwa's `selfDestroying: true`
 * to unregister fleet-wide.
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

function isHtml(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/html');
}

/**
 * Fetch the canonical shell and pin it. `credentials: 'include'` so the
 * `ws_ui` cookie picks the right theme + accent variant. Throws on a
 * failed fetch or a non-HTML response — callers decide whether that is
 * fatal (install) or a keep-the-old-copy no-op (message re-warm).
 */
async function warmCanonical(): Promise<void> {
  const response = await fetch(CANONICAL_URL, { credentials: 'include' });
  if (!response.ok || !isHtml(response)) {
    throw new Error(`canonical shell warm failed (${response.status})`);
  }
  const cache = await caches.open(CANONICAL_CACHE);
  await cache.put(CANONICAL_URL, response);
}

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
 * Every `/m` navigation returns the same accent-substituted shell
 * bytes, so any successful one can refresh the pinned canonical copy —
 * NetworkFirst alone would only update `/m/app`'s entry when `/m/app`
 * itself is navigated. Workbox requires `fetchDidSucceed` to return a
 * Response; the write is awaited (an unawaited write can be terminated
 * with the worker) and a write failure must never break the
 * navigation.
 */
const canonicalRefreshPlugin = {
  fetchDidSucceed: async ({
    response,
  }: {
    response: Response;
  }): Promise<Response> => {
    if (response.ok && isHtml(response)) {
      try {
        const cache = await caches.open(CANONICAL_CACHE);
        await cache.put(CANONICAL_URL, response.clone());
      } catch {
        // Storage pressure or shutdown — the navigation still succeeds.
      }
    }
    return response;
  },
};

registerRoute(
  ({ request, url }) =>
    request.mode === 'navigate' &&
    (url.pathname === '/m' || url.pathname.startsWith('/m/')),
  new NetworkFirst({
    cacheName: SHELL_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 24, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      canonicalRefreshPlugin,
    ],
  }),
);

/**
 * A failed navigation with no exact-URL cache entry serves the pinned
 * canonical shell — from the NAMED cache, never global `caches.match()`
 * (which would search the precache and other versions). Non-navigation
 * failures surface as network errors, untouched.
 */
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const cache = await caches.open(CANONICAL_CACHE);
    const cached = await cache.match(CANONICAL_URL);
    if (cached) return cached;
  }
  return Response.error();
});
