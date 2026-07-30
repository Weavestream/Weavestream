import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Weavestream Mobile — static bundle served at `/m` by the Next.js
 * container (Phase 0), and bundled into a Capacitor binary later. The
 * "must build to static files" constraint is why this is a Vite app and
 * not a second Next app: `output: 'export'` bans route handlers,
 * `headers()`, `redirects()`, and `proxy.ts`, and would need
 * `generateStaticParams` for data-driven routes like `/m/passwords/:id`.
 */
/**
 * Mermaid's package tree, plus the packages it is this app's sole
 * consumer of.
 *
 * A prefix matching only `mermaid` would leave automatically-factored
 * d3 / cytoscape / katex / dagre / roughjs chunks with ordinary names,
 * and therefore inside the service worker's precache — the exact thing
 * the exclusion exists to prevent.
 *
 * This list is maintained, not trusted, and it covers TRANSITIVE deps
 * too — `lodash-es` (reached through `dagre-d3-es`) was missing from the
 * first version and produced a chunk called `map-<hash>.js` that sailed
 * past the glob and got precached. `emit-to-web.mjs`'s graph assertion is
 * what caught it, and is what will catch the next one. When that
 * assertion fails naming a chunk, add its package here rather than
 * widening the glob.
 *
 * `marked` and `dayjs` are watched but deliberately unlisted: they are
 * plausible future app dependencies, and forcing a shared package into a
 * network-only chunk would be worse than the assertion complaining.
 */
const MERMAID_PKG_RE =
  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(?:mermaid|@mermaid-js[\\/][^\\/]+|dompurify|css-tree|mdn-data|source-map-js|es-toolkit|lodash-es|d3(?:-[^\\/]+)?|cytoscape(?:-[^\\/]+)?|dagre-d3-es|katex|khroma|roughjs|stylis|ts-dedent|@braintree[\\/]sanitize-url|@iconify[\\/]utils|@upsetjs[\\/]venn\.js)[\\/]/;

export default defineConfig({
  plugins: [
    react(),
    /**
     * Phase 3 service worker. `injectManifest` compiles our hand-written
     * `src/sw.ts` (versioned caches, install-warmed canonical shell,
     * NetworkFirst navigations, NO /api route — see that file for the
     * caching policy and its security invariant) and injects the
     * precache manifest.
     *
     *  - `injectRegister: null` — the plugin must NEVER inject a
     *    registration script into index.html: the `/m` CSP is
     *    `script-src 'self'` with no inline allowance, and the shell
     *    HTML must stay byte-identical for the accent pipeline
     *    (`emit-to-web.mjs` stamps one variant per accent).
     *    Registration lives in `main.tsx` via `virtual:pwa-register`.
     *  - `manifest: false` — `public/manifest.webmanifest` is the
     *    manifest (scope/start_url reasoning in MANIFEST-NOTES.md); do
     *    not generate a second one.
     *  - Precache globs exclude HTML: `dist/index.html` carries the
     *    literal `__WS_ACCENT__` placeholder — precaching it would
     *    serve a broken shell. The runtime canonical-shell cache in
     *    sw.ts is what provides offline boot instead.
     */
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: null,
      manifest: false,
      devOptions: { enabled: false },
      injectManifest: {
        globPatterns: ['**/*.{js,css,woff2}'],
        /**
         * The diagram engine is network-only, deliberately.
         *
         * Precaching it would add ~200 KB gz to every PWA install and
         * force a re-download for every installed technician on the
         * deploy that lands it — for a feature many of them will never
         * open. The trade is that a diagram needs a connection to draw;
         * offline, `MermaidBlock` shows the diagram source with a
         * caption saying so, which for a runbook is a real answer.
         *
         * Supplying `globIgnores` REPLACES workbox's default, so the
         * node_modules guard is restated rather than inherited.
         */
        globIgnores: [
          '**/node_modules/**/*',
          'assets/mermaid-*.js',
          '**/mermaid-*.js',
        ],
      },
    }),
  ],

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

    /**
     * Give every chunk in the Mermaid closure a recognisable filename
     * prefix.
     *
     * Two things depend on it. The service worker's precache
     * (`injectManifest.globIgnores` above) excludes `mermaid-*` so a
     * technician who never opens a diagram never downloads the diagram
     * engine; and `scripts/emit-to-web.mjs` asserts at publish time that
     * the closure really is network-only.
     *
     * Rolldown's default `[name]-[hash].js` gives these no common prefix
     * (`flowDiagram-…`, `cytoscape.esm-…`, `katex-…`), so it has to be
     * forced. Both `facadeModuleId` and `moduleIds` are checked because a
     * facade chunk carries no modules of its own.
     *
     * **Deliberately NO `codeSplitting.groups` here.** Grouping the
     * closure works — it produces one tidy chunk — but that chunk is
     * ~3.4 MB, because it merges in every diagram type Mermaid can
     * render. Left ungrouped, Mermaid's own per-type lazy imports
     * survive, so opening a flowchart fetches the core plus the flowchart
     * chunk and leaves cytoscape (425 KB) and katex (253 KB) on the
     * server. That laziness is the reason Mermaid ships it; on a field
     * device it is worth ~98 content-hashed files in `assets/`.
     *
     * The predicate is a naming convenience, not the correctness
     * boundary — `emit-to-web.mjs` walks the manifest graph, so a chunk
     * that escapes it fails the publish rather than silently ending up
     * precached.
     */
    rolldownOptions: {
      output: {
        chunkFileNames: (chunk) =>
          [chunk.facadeModuleId, ...chunk.moduleIds].some(
            (id) => typeof id === 'string' && MERMAID_PKG_RE.test(id),
          )
            ? 'assets/mermaid-[name]-[hash].js'
            : 'assets/[name]-[hash].js',
      },
    },
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
