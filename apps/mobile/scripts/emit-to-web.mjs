#!/usr/bin/env node
/**
 * Publish the mobile bundle into `apps/web`.
 *
 * Two output trees, and the split is deliberate:
 *
 *   apps/web/public/m/       hashed assets + the web manifest, served by
 *                            Next's public folder (`max-age=0` + ETag —
 *                            NOT `immutable`; see next.config.js for why
 *                            a pathname-keyed immutable header was
 *                            removed)
 *   apps/web/mobile-shell/   one HTML shell per accent × theme-pref
 *                            pair, OUTSIDE public/
 *
 * The shell must not live under `public/`. Next resolves public files by
 * exact set membership and static files win before dynamic routes, so a
 * `public/m/shell.html` would be reachable at `/m/shell.html` and would
 * bypass the route handler entirely — no accent selection, and
 * `max-age=0` instead of `no-store`. A second, cacheable entry point
 * going stale is precisely the white-screen failure this pipeline exists
 * to prevent. Keeping it out of `public/` makes that unreachable by
 * construction rather than by a block rule.
 *
 * Publication is atomic: everything is staged under `.mobile-stage/` and
 * swapped in by rename, so a concurrent reader never sees a half-written
 * tree. The staging directory is cleared on entry, so a killed build
 * leaves no remnants for the next one (or for a Docker context) to pick up.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm, mkdir, cp, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, '..');
const WEB = resolve(MOBILE, '../web');

const DIST = join(MOBILE, 'dist');
const PUBLIC_SRC = join(MOBILE, 'public');
const STAGE = join(WEB, '.mobile-stage');
const PUBLIC_M = join(WEB, 'public', 'm');
const SHELL_DIR = join(WEB, 'mobile-shell');
const MARKER = 'mobile-build.json';

const ACCENT_PLACEHOLDER = '__WS_ACCENT__';
const THEME_PLACEHOLDER = '__WS_THEME__';
const THEME_PREF_PLACEHOLDER = '__WS_THEME_PREF__';
const TC_LIGHT_PLACEHOLDER = '__WS_TC_LIGHT__';
const TC_DARK_PLACEHOLDER = '__WS_TC_DARK__';

/* The two `--bg` values from packages/shared/styles/color-tokens.css,
 * stamped into the theme-color metas so the status bar is right on the
 * first frame. An explicit pref stamps one value into both metas;
 * `system` stamps the pair and lets the OS media query pick. */
const BG_LIGHT = '#fafaf9';
const BG_DARK = '#0a0a0a';

/**
 * The compiled service worker (Phase 3). Emitted by vite-plugin-pwa
 * into `dist/`, NOT listed in the Vite manifest — so it must be named
 * in the keep-set explicitly or the prune below would delete it right
 * after the copy carried it in.
 */
const SERVICE_WORKER = 'sw.js';

/**
 * Replaced in the staged copy of sw.js with a hash of the compiled
 * worker, so its cache versions change whenever the WORKER changes —
 * not only when the precache manifest does. Without it, an SW-code-only
 * deploy would install into the active worker's same-named caches (see
 * the BUILD_ID comment in src/sw.ts). `dist/` keeps the placeholder, so
 * republishing an unchanged build stamps the identical value.
 */
const SW_BUILD_PLACEHOLDER = '__WS_SW_BUILD__';

/**
 * The precache manifest injected into the compiled worker must contain
 * no HTML: `dist/index.html` carries the `__WS_ACCENT__` placeholder,
 * and a precached copy would serve that broken shell to every offline
 * boot. A plain `index.html` grep is NOT a valid check — Workbox's own
 * bundled routing code contains the `directoryIndex: 'index.html'`
 * default string — so this parses the `{url, revision}` entries out of
 * the injected array instead.
 */
function assertNoHtmlPrecached(swSource) {
  const urls = [...swSource.matchAll(/"url"\s*:\s*"([^"]+)"|url\s*:\s*"([^"]+)"/g)]
    .map((m) => m[1] ?? m[2])
    .filter(Boolean);
  if (urls.length === 0) {
    throw new Error(
      'sw.js contains no precache manifest entries — the vite-plugin-pwa ' +
        'injection failed or the glob matched nothing',
    );
  }
  const html = urls.filter((u) => u.endsWith('.html'));
  if (html.length > 0) {
    throw new Error(
      `sw.js precaches HTML (${html.join(', ')}) — the accent-placeholder ` +
        'shell must never be precached; fix the injectManifest globPatterns',
    );
  }
}

/** The `{url}` entries Workbox injected, in the same shape as above. */
function precacheUrls(swSource) {
  return [...swSource.matchAll(/"url"\s*:\s*"([^"]+)"|url\s*:\s*"([^"]+)"/g)]
    .map((m) => m[1] ?? m[2])
    .filter(Boolean);
}

/**
 * The diagram engine must stay lazily loaded AND out of the precache.
 *
 * A filename check is not enough and must not be what ships. It cannot
 * see an automatically-factored d3/cytoscape/katex chunk that happened
 * to get an ordinary name, and it cannot tell a dynamically-reached
 * `mermaid-*` chunk from a statically-reached one — manual chunk naming
 * will happily produce `mermaid-*` for something the entry imports
 * eagerly. Both failure modes report green while the decision has
 * silently reversed: someone converts `import('./mermaid-runtime')` to a
 * static import and every technician's PWA install grows by the whole
 * Mermaid engine, with no visible symptom.
 *
 * So walk the manifest graph instead.
 *
 * The subtraction is required, not tidiness: `@weavestream/shared`'s
 * browser barrel is reachable BOTH statically (the palette hook renders
 * eagerly) and dynamically (the runtime), and Vite's manifest models
 * exactly that. A plain "no overlap" assertion would fail on a correct
 * build — and the predictable response to a red build that is actually
 * green is to weaken the assertion until it passes.
 */
function assertDiagramEngineIsLazy(manifest, swSource) {
  const byFile = new Map(Object.values(manifest).map((c) => [c.file, c]));
  const entry = Object.values(manifest).find((c) => c.isEntry);
  if (!entry) throw new Error('vite manifest has no entry chunk');

  /**
   * `stopAt` is load-bearing. The Mermaid runtime chunk statically
   * imports the ENTRY chunk back (they share application code), so a
   * naive traversal walks into the entry and then out along *its*
   * dynamic imports — reporting `virtual:pwa-register` and
   * workbox-window as diagram chunks. Reaching an already-static node
   * ends that branch: it is shared code, not part of the engine.
   */
  const walk = (start, edges, stopAt) => {
    const seen = new Set();
    const queue = [start];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      if (stopAt?.has(file) && file !== start) continue;
      seen.add(file);
      const chunk = byFile.get(file);
      if (!chunk) continue;
      for (const key of edges) {
        for (const f of chunk[key] ?? []) queue.push(manifest[f]?.file ?? f);
      }
    }
    return seen;
  };

  const staticClosure = walk(entry.file, ['imports']);

  const runtime = Object.entries(manifest).find(([id]) =>
    id.endsWith('src/lib/mermaid-runtime.ts'),
  )?.[1];
  if (!runtime) {
    throw new Error(
      'no manifest entry for src/lib/mermaid-runtime.ts — the diagram ' +
        'runtime was renamed or its dynamic import was removed; this guard ' +
        'must never pass vacuously',
    );
  }
  if (staticClosure.has(runtime.file)) {
    throw new Error(
      `${runtime.file} is reachable from the entry via STATIC imports — the ` +
        'diagram engine would ship in the eager bundle and be precached. ' +
        "Restore the dynamic `import('../../lib/mermaid-runtime')`.",
    );
  }

  const networkOnly = [
    ...walk(runtime.file, ['imports', 'dynamicImports'], staticClosure),
  ].filter((f) => !staticClosure.has(f));

  if (networkOnly.length === 0) {
    throw new Error(
      'the Mermaid closure is empty — it collapsed into the entry bundle; ' +
        'check build.rolldownOptions.output.chunkFileNames in vite.config.ts',
    );
  }

  const precached = new Set(precacheUrls(swSource));
  const leaked = networkOnly.filter((f) => precached.has(f));
  if (leaked.length > 0) {
    throw new Error(
      `sw.js precaches ${leaked.length} diagram chunk(s) (${leaked
        .slice(0, 3)
        .join(', ')}${leaked.length > 3 ? ', …' : ''}) — the engine must stay ` +
        'network-only; check injectManifest.globIgnores in vite.config.ts',
    );
  }

  return networkOnly.length;
}

/**
 * Read the accent + theme-pref enums from the shared package rather
 * than hardcoding them, so adding a sixth accent (or, however unlikely,
 * a fourth theme pref) regenerates the variants automatically instead
 * of silently shipping a subset.
 */
async function uiEnums() {
  const shared = await import('@weavestream/shared');
  const accents = shared.uiAccentValues;
  const themePrefs = shared.uiThemeValues;
  if (!Array.isArray(accents) || accents.length === 0) {
    throw new Error('uiAccentValues missing from @weavestream/shared');
  }
  if (!Array.isArray(themePrefs) || themePrefs.length === 0) {
    throw new Error('uiThemeValues missing from @weavestream/shared');
  }
  return {
    accents,
    themePrefs,
    fallbackAccent: shared.DEFAULT_UI_ACCENT,
    fallbackTheme: shared.DEFAULT_UI_THEME,
    resolveSsrTheme: shared.resolveSsrTheme,
  };
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Every `/m/...` URL the shell actually references. */
function referencedUrls(html) {
  return [...html.matchAll(/(?:src|href)="(\/m\/[^"]+)"/g)].map((m) => m[1]);
}

/**
 * Replace a directory: move the current one aside, rename the staged one
 * into place, then delete what was moved aside.
 *
 * The "aside" location is INSIDE `.mobile-stage/`, not a sibling of the
 * target. A sibling (`public/m.retired-1234`) would survive an interrupt
 * between the two renames, and nothing would ever clean it: the next run
 * only clears `.mobile-stage`, and `public/m.retired-*` matches neither
 * `.gitignore` nor `.dockerignore`, so a stale tree of assets could be
 * committed or swept into a Docker build context. Retiring into the
 * staging directory means the entry-clear at the top of `main()` collects
 * it on the next run, and the single ignore entry already covers it.
 *
 * `rename` across the two paths stays same-filesystem (both under
 * `apps/web`), so each swap is still atomic.
 */
async function swapIn(stagedPath, targetPath, retireDir) {
  const retired = join(retireDir, `${basename(targetPath)}-previous`);
  if (existsSync(targetPath)) {
    await mkdir(retireDir, { recursive: true });
    await rename(targetPath, retired);
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await rename(stagedPath, targetPath);
  if (existsSync(retired)) await rm(retired, { recursive: true, force: true });
}

/**
 * The asset list recorded by the previous publish, if any. Used to keep
 * one generation of assets alive across a deploy so a reader mid-load
 * cannot 404 on the app it is currently running.
 */
async function readPublishedAssets() {
  try {
    const prev = JSON.parse(
      await readFile(join(SHELL_DIR, MARKER), 'utf8'),
    );
    return Array.isArray(prev.assets) ? prev.assets : [];
  } catch {
    return [];
  }
}

/** Delete files under `public/m` that no longer belong to either generation. */
async function pruneAssets(keep) {
  const pruned = [];
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, key);
      } else if (!keep.has(key)) {
        await rm(abs, { force: true });
        pruned.push(key);
      }
    }
  }
  if (existsSync(PUBLIC_M)) await walk(PUBLIC_M, '');
  return pruned;
}

async function main() {
  if (!existsSync(DIST)) {
    throw new Error(`vite build output missing at ${DIST} — run \`vite build\` first`);
  }

  // Loud failure over a silent regression, like the __WS_ACCENT__ check
  // below: a plugin misconfiguration that stops emitting the worker
  // must fail the publish, not ship a bundle that quietly loses its
  // offline capability (and leaves clients running the previous SW
  // forever).
  const swPath = join(DIST, SERVICE_WORKER);
  if (!existsSync(swPath)) {
    throw new Error(
      `dist/${SERVICE_WORKER} missing — vite-plugin-pwa did not emit the ` +
        'service worker; check the plugin config in vite.config.ts',
    );
  }
  const swSource = await readFile(swPath, 'utf8');
  assertNoHtmlPrecached(swSource);
  if (!swSource.includes(SW_BUILD_PLACEHOLDER)) {
    throw new Error(
      `sw.js lost its ${SW_BUILD_PLACEHOLDER} placeholder — cache versions ` +
        'would stop tracking worker changes and an installing worker could ' +
        "mutate the active worker's caches; see src/sw.ts",
    );
  }
  const stampedSw = swSource.replaceAll(
    SW_BUILD_PLACEHOLDER,
    sha256(swSource).slice(0, 16),
  );

  const {
    accents: ACCENTS,
    themePrefs: THEME_PREFS,
    fallbackAccent,
    fallbackTheme,
    resolveSsrTheme,
  } = await uiEnums();

  // Clear staging first: remnants of an interrupted build must never be
  // published or swept into a Docker context.
  await rm(STAGE, { recursive: true, force: true });
  const stageAssets = join(STAGE, 'm');
  const stageShells = join(STAGE, 'mobile-shell');
  await mkdir(stageAssets, { recursive: true });
  await mkdir(stageShells, { recursive: true });

  // ---- assets ----------------------------------------------------------
  // Everything except the HTML entry, which becomes the shell variants.
  for (const entry of await readdir(DIST, { withFileTypes: true })) {
    if (entry.name === 'index.html') continue;
    await cp(join(DIST, entry.name), join(stageAssets, entry.name), {
      recursive: true,
    });
  }
  // The published worker carries the stamped build id; dist/ keeps the
  // placeholder so a republish of an unchanged build is byte-identical.
  await writeFile(join(stageAssets, SERVICE_WORKER), stampedSw, 'utf8');

  // ---- shell variants --------------------------------------------------
  const template = await readFile(join(DIST, 'index.html'), 'utf8');
  for (const placeholder of [
    ACCENT_PLACEHOLDER,
    THEME_PLACEHOLDER,
    THEME_PREF_PLACEHOLDER,
    TC_LIGHT_PLACEHOLDER,
    TC_DARK_PLACEHOLDER,
  ]) {
    if (!template.includes(placeholder)) {
      throw new Error(
        `index.html lost its ${placeholder} placeholder — the route handler ` +
          'would serve one theme/accent to everyone',
      );
    }
  }

  /**
   * Build-time codegen from compile-time enums. NOT per-request
   * substitution of request data into HTML (CLAUDE.md §3).
   *
   * `data-theme` gets the *resolved* theme (system stamps dark,
   * mirroring `resolveSsrTheme`); the token stylesheets' media blocks
   * correct a system-pref/light-OS first paint in pure CSS. theme-color:
   * an explicit pref stamps one value into both metas; system stamps
   * the light/dark pair so the OS picks pre-hydration.
   */
  function stampShell(accent, pref) {
    const resolved = resolveSsrTheme({ uiTheme: pref, uiAccent: accent });
    const tcLight = pref === 'dark' ? BG_DARK : BG_LIGHT;
    const tcDark = pref === 'light' ? BG_LIGHT : BG_DARK;
    return template
      .replaceAll(ACCENT_PLACEHOLDER, accent)
      .replaceAll(THEME_PLACEHOLDER, resolved)
      .replaceAll(THEME_PREF_PLACEHOLDER, pref)
      .replaceAll(TC_LIGHT_PLACEHOLDER, tcLight)
      .replaceAll(TC_DARK_PLACEHOLDER, tcDark);
  }

  const shells = {};
  for (const accent of ACCENTS) {
    for (const pref of THEME_PREFS) {
      const html = stampShell(accent, pref);
      const key = `${accent}-${pref}`;
      await writeFile(join(stageShells, `${key}.html`), html, 'utf8');
      shells[key] = sha256(html);
    }
  }

  // ---- marker ----------------------------------------------------------
  // Consumed by apps/web's prebuild guard. Asset list + per-variant hash
  // is what lets it tell "stale" and "half-copied" apart from "missing".
  const viteManifest = JSON.parse(
    await readFile(join(DIST, '.vite', 'manifest.json'), 'utf8'),
  );
  const lazyDiagramChunks = assertDiagramEngineIsLazy(viteManifest, swSource);
  const assets = [
    ...new Set(
      Object.values(viteManifest).flatMap((c) => [
        c.file,
        ...(c.css ?? []),
        ...(c.assets ?? []),
      ]),
    ),
  ]
    .filter(Boolean)
    .sort();

  const marker = {
    // Bumped by hand if the guard's expectations change.
    // 2: serviceWorker field added (Phase 3) — a schema-1 marker means
    // a pre-SW publish and must fail the guard until republished.
    // 3: theme-variant shells (Phase 4) — `shells` is keyed by
    // `{accent}-{themePref}` and `themePrefs`/`fallbackTheme` exist. A
    // schema-2 marker means an accent-only publish whose variants the
    // theme-aware route handler cannot find; fail until republished.
    schema: 3,
    fallbackAccent,
    fallbackTheme,
    accents: ACCENTS,
    themePrefs: THEME_PREFS,
    shells,
    assets,
    serviceWorker: SERVICE_WORKER,
    serviceWorkerSha256: sha256(stampedSw),
    // The shell's own view of what must exist, which is the thing that
    // actually white-screens if it drifts. Referenced URLs are
    // placeholder-independent, so any fully-stamped variant works.
    referenced: referencedUrls(stampShell(fallbackAccent, fallbackTheme)).sort(),
  };
  await writeFile(
    join(stageShells, MARKER),
    JSON.stringify(marker, null, 2),
    'utf8',
  );

  // ---- publish ---------------------------------------------------------
  //
  // Two directories cannot be swapped in one atomic operation, so the
  // scheme is built to make the intermediate state harmless instead:
  //
  //   1. MERGE new assets in additively — nothing is deleted. Filenames
  //      are content-hashed, so old and new coexist without collision.
  //      A concurrent reader still holding the previous shell keeps
  //      working, because the assets it references are still there.
  //   2. Swap the shell directory atomically (one rename). This is the
  //      cutover: before it, everyone sees the old app; after it,
  //      everyone sees the new one, and the assets it needs are already
  //      in place from step 1.
  //   3. Prune assets belonging to the build *before* last, never the
  //      one just replaced. That leaves a full generation of overlap, so
  //      a reader mid-load across the cutover cannot 404.
  //
  // An earlier version replaced the asset directory wholesale before
  // swapping shells. That deleted the running app's assets while its
  // shell was still live — the white-screen condition this pipeline
  // exists to prevent, reachable by simply deploying twice.
  const previousAssets = await readPublishedAssets();

  await mkdir(PUBLIC_M, { recursive: true });
  for (const entry of await readdir(stageAssets, { withFileTypes: true })) {
    await cp(join(stageAssets, entry.name), join(PUBLIC_M, entry.name), {
      recursive: true,
      force: true,
    });
  }

  await swapIn(stageShells, SHELL_DIR, join(STAGE, 'retired'));

  // Files Vite copies verbatim out of `apps/mobile/public/` (the web
  // manifest, icons) never appear in the Vite manifest, so they must be
  // named explicitly or the prune would delete them.
  const passthrough = existsSync(PUBLIC_SRC)
    ? (await readdir(PUBLIC_SRC, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : [];

  const keep = new Set([
    ...assets,
    ...previousAssets,
    ...passthrough,
    // Not in the Vite manifest (vite-plugin-pwa emits it directly), so
    // without this line the prune would delete the worker the copy loop
    // just published.
    SERVICE_WORKER,
  ]);
  const pruned = await pruneAssets(keep);

  await rm(STAGE, { recursive: true, force: true });

  console.log(
    `[mobile] published ${assets.length} assets → apps/web/public/m, ` +
      `${Object.keys(shells).length} shell variants → apps/web/mobile-shell` +
      (pruned.length ? ` (pruned ${pruned.length} from an older build)` : ''),
  );
  // Logged so the deferred cost stays visible in build output rather
  // than growing unnoticed.
  console.log(
    `[mobile] ${lazyDiagramChunks} diagram chunks are network-only (not precached)`,
  );
}

main().catch((err) => {
  console.error('[mobile] publish failed:', err.message);
  process.exit(1);
});
