import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Weavestream Mobile — static bundle served at `/m` by the Next.js
 * container (Phase 0), and bundled into a Capacitor binary later. The
 * "must build to static files" constraint is why this is a Vite app and
 * not a second Next app: `output: 'export'` bans route handlers,
 * `headers()`, `redirects()`, and `proxy.ts`, and would need
 * `generateStaticParams` for data-driven routes like `/m/passwords/:id`.
 */
export default defineConfig({
  plugins: [react()],

  // Assets are served from `apps/web/public/m/assets/*`. Independent of
  // the HTML entry URL, which is `/m/app` — see the route handler.
  base: '/m/',

  build: {
    // REQUIRED by the `/m` CSP branch (`apps/web/src/lib/csp.ts`).
    // Vite otherwise injects a small *inline* module-preload polyfill,
    // which `script-src 'self'` correctly rejects — the page then renders
    // blank with a single console violation and no other symptom. Costs a
    // preload optimisation on older Safari and nothing else. Do NOT
    // "fix" a CSP violation here by adding 'unsafe-inline'.
    modulePreload: { polyfill: false },

    // Emitted so the postbuild can record the exact asset list in
    // `mobile-build.json`, which is what lets `apps/web`'s prebuild guard
    // detect a stale or half-copied bundle rather than merely a missing one.
    manifest: true,

    // Vite's default. Named explicitly because `scripts/emit-to-web.mjs`
    // reads from here and would fail confusingly if it moved.
    outDir: 'dist',
  },

  optimizeDeps: {
    // `@weavestream/shared` is a workspace-linked package that emits
    // CommonJS (it has no `"type": "module"`, and the Nest API requires
    // it). Vite treats linked deps as source and does not pre-bundle them
    // by default, which makes named imports from a CJS `export *` chain
    // fail. Forcing them through the optimizer converts them to ESM once,
    // at dev-server start.
    include: ['@weavestream/shared', '@weavestream/shared/browser'],
  },

  server: {
    host: true, // reachable from a phone on the LAN
    port: 5173,
    // Relative `/api/v1/*` calls would otherwise hit Vite's own origin
    // and 404. Proxy to **Next**, not directly to the API: that keeps the
    // `/api/[...path]` route handler, its X-Forwarded-For sanitisation,
    // and the full cookie jar in the dev path, so what we exercise here
    // matches production. Cookies cross the port boundary fine — cookies
    // are port-agnostic and SameSite is scheme + registrable-domain.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/health': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
