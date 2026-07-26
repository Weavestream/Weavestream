// Load the monorepo-root `.env` into process.env before Next.js resolves
// its own config. Next only auto-loads `.env*` from the package directory
// (apps/web), so without this step variables like `API_INTERNAL_URL` stay
// unset during `pnpm dev`, and the API rewrite below silently falls back
// to `http://api:4000` — the Docker Compose service hostname, which does
// not resolve on the host and surfaces as `getaddrinfo ENOTFOUND api`.
//
// Mirrors the behavior of `apps/api/src/load-env.ts`: walk up from cwd
// looking for the first `.env`, and never override values that are
// already set in the process (so Docker Compose `environment:` still
// wins in production).
const { existsSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

(function loadWorkspaceEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      require('dotenv').config({ path: candidate, override: false });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
})();

/** @type {import('next').NextConfig} */

// Dev-only: allow the dev server's HMR / dev-resource endpoints to be reached
// from non-localhost origins (e.g. testing the UI on a phone over the LAN).
// Next 16 hard-blocks these by default, which causes the React bundle to fail
// to hydrate on a non-localhost origin — the login form's onSubmit handler
// then never binds and tapping "Sign in" silently degrades to a plain HTML
// form GET, so no `/auth/login` POST ever reaches the API.
//
// In dev we additionally seed the host's primary LAN IPv4 address(es) so
// laptop ↔ phone testing works out-of-the-box without anyone editing this
// file. Comma-separated env override (`WEB_ALLOWED_DEV_ORIGINS=...`) wins
// over auto-detection. Production builds ignore this entirely.
const { networkInterfaces } = require('node:os');

function detectLanIPs() {
  const out = new Set();
  try {
    const ifaces = networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const i of list) {
        if (i.family === 'IPv4' && !i.internal) out.add(i.address);
      }
    }
  } catch {
    /* no-op */
  }
  return [...out];
}

const envOrigins = (process.env.WEB_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const allowedDevOrigins = [
  ...new Set([
    ...envOrigins,
    ...(process.env.NODE_ENV === 'production' ? [] : detectLanIPs()),
  ]),
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Hide the Next 16 dev-only "N" badge. Build/runtime errors still surface.
  devIndicators: false,
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
  // Rewrite barrel imports (`from '@tiptap/react'`) into deep named imports
  // so Turbopack only compiles the symbols we actually reference. In dev
  // this is the difference between shipping the entire Tiptap / dnd-kit /
  // ProseMirror graph to every route and shipping ~the page you're on.
  // Especially noticeable in Safari, whose dev-bundle parse time is several
  // times slower than V8.
  experimental: {
    optimizePackageImports: [
      '@tiptap/react',
      '@tiptap/starter-kit',
      '@tiptap/pm',
      '@tiptap/suggestion',
      '@tiptap/extension-bubble-menu',
      '@tiptap/extension-image',
      '@tiptap/extension-link',
      '@tiptap/extension-mention',
      '@tiptap/extension-placeholder',
      '@tiptap/extension-task-item',
      '@tiptap/extension-task-list',
      '@dnd-kit/core',
      '@dnd-kit/sortable',
      '@dnd-kit/utilities',
    ],
  },
  // Browser → API traffic now flows through the App Router proxy at
  // `src/app/api/[...path]/route.ts` (and the matching `/health`
  // handlers) instead of a Next.js rewrite. The route handler is the
  // only place we can rewrite inbound `X-Forwarded-For` / `X-Real-IP`
  // to a single sanitized entry, which is required to prevent an
  // internet client from spoofing their apparent IP for the API's
  // rate limit, lockout, IP-rule, and audit attribution code paths.
  // See `apps/web/src/lib/api-proxy.ts` and `apps/web/src/proxy.ts`.
  // Short-circuit the unauthenticated root hit at the routing layer instead
  // of letting the root Server Component call `redirect('/login')`. An RSC
  // redirect emits a 307 with an HTML/RSC payload body (ZAP flags this as
  // "Big Redirect"); a config-level redirect emits a 307 with an empty body.
  // Authenticated users fall through to page.tsx where role-based routing
  // still runs.
  async redirects() {
    return [
      {
        source: '/',
        missing: [{ type: 'cookie', key: 'ws_session' }],
        destination: '/login',
        permanent: false,
      },
    ];
  },
  // Security headers for `/_next/static/*`. The edge proxy (apps/web/src/proxy.ts)
  // deliberately skips the `_next/*` tree so it doesn't intercept the HMR
  // WebSocket, which means static assets would otherwise ship without CSP or
  // nosniff. Add a minimal hardening pass here: these files can't execute as
  // scripts, so `default-src 'none'` is the tightest safe policy.
  async headers() {
    return [
      {
        source: '/_next/static/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Content-Security-Policy', value: "default-src 'none'" },
        ],
      },
      // The mobile PWA's hashed assets.
      //
      // NOTE: deliberately NO `Cache-Control: immutable` here, and do not
      // re-add one. `headers()` matches by pathname and knows nothing
      // about the response, so the rule also applied to requests for
      // assets that DO NOT EXIST — which the `/m` catch-all answers with
      // a 404. It also *replaces* any Cache-Control the route handler
      // sets, so the handler cannot opt out.
      //
      // The result was a 404 cached for a year against a content-hashed
      // URL. That is a rollback landmine: a browser that requests
      // `/m/assets/index-<hash>.js` during a deploy race (shell fetched
      // from build A, assets already replaced by build B) caches the
      // miss, and if that build is ever rolled back the same browser
      // serves the cached 404 forever and the app is dead for that user.
      // Low probability, permanent consequence, no server-side fix.
      //
      // Assets therefore fall back to Next's public-folder default
      // (`max-age=0` + ETag), which is what every other file under
      // `public/` already gets — repeat loads are cheap 304s. Aggressive
      // asset caching for the PWA belongs in the Phase 3 service worker,
      // where it can be versioned and invalidated deliberately, rather
      // than in an HTTP header that cannot distinguish a hit from a miss.
      {
        source: '/m/assets/:path*',
        headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
      },
    ];
  },
};

module.exports = nextConfig;
