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
const API_URL = process.env.API_INTERNAL_URL ?? 'http://api:4000';

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
    // Next.js dev rewrites have a hardcoded 30s proxy timeout that
    // kills long-running streamed responses (chat SSE in particular —
    // a slow LLM round-trip easily exceeds 30s before the first
    // delta lands). We mirror the API's own `STREAM_TIMEOUT_MS`
    // (120s) so the proxy never aborts before the server does.
    // See https://github.com/vercel/next.js/issues/36251.
    proxyTimeout: 120_000,
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
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_URL}/api/:path*`,
      },
      // `/health` (anonymous liveness) and `/health/:path*` (authenticated
      // readiness/queue diagnostics) both proxy to the API. The API
      // enforces auth on the sub-paths, so opening this rewrite is safe.
      {
        source: '/health',
        destination: `${API_URL}/health`,
      },
      {
        source: '/health/:path*',
        destination: `${API_URL}/health/:path*`,
      },
    ];
  },
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
    ];
  },
};

module.exports = nextConfig;
