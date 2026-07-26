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
 *   apps/web/mobile-shell/   one HTML shell per accent, OUTSIDE public/
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

/**
 * Read the accent list from the shared package rather than hardcoding
 * it, so adding a sixth accent regenerates the variants automatically
 * instead of silently shipping five.
 */
async function accents() {
  const shared = await import('@weavestream/shared');
  const values = shared.uiAccentValues;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('uiAccentValues missing from @weavestream/shared');
  }
  return { values, fallback: shared.DEFAULT_UI_ACCENT };
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

  const { values: ACCENTS, fallback } = await accents();

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

  // ---- shell variants --------------------------------------------------
  const template = await readFile(join(DIST, 'index.html'), 'utf8');
  if (!template.includes(ACCENT_PLACEHOLDER)) {
    throw new Error(
      `index.html lost its ${ACCENT_PLACEHOLDER} placeholder — the route handler ` +
        'would serve one accent to everyone',
    );
  }

  const shells = {};
  for (const accent of ACCENTS) {
    // Build-time codegen from a compile-time enum. NOT per-request
    // substitution of request data into HTML (CLAUDE.md §3).
    const html = template.replaceAll(ACCENT_PLACEHOLDER, accent);
    await writeFile(join(stageShells, `${accent}.html`), html, 'utf8');
    shells[accent] = sha256(html);
  }

  // ---- marker ----------------------------------------------------------
  // Consumed by apps/web's prebuild guard. Asset list + per-variant hash
  // is what lets it tell "stale" and "half-copied" apart from "missing".
  const viteManifest = JSON.parse(
    await readFile(join(DIST, '.vite', 'manifest.json'), 'utf8'),
  );
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
    schema: 1,
    fallbackAccent: fallback,
    accents: ACCENTS,
    shells,
    assets,
    // The shell's own view of what must exist, which is the thing that
    // actually white-screens if it drifts.
    referenced: referencedUrls(template.replaceAll(ACCENT_PLACEHOLDER, fallback))
      .sort(),
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

  const keep = new Set([...assets, ...previousAssets, ...passthrough]);
  const pruned = await pruneAssets(keep);

  await rm(STAGE, { recursive: true, force: true });

  console.log(
    `[mobile] published ${assets.length} assets → apps/web/public/m, ` +
      `${ACCENTS.length} shell variants → apps/web/mobile-shell` +
      (pruned.length ? ` (pruned ${pruned.length} from an older build)` : ''),
  );
}

main().catch((err) => {
  console.error('[mobile] publish failed:', err.message);
  process.exit(1);
});
