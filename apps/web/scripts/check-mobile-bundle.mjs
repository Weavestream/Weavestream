#!/usr/bin/env node
/**
 * Prebuild guard: refuse to build `apps/web` against a missing, stale, or
 * half-copied mobile bundle.
 *
 * Why this is not just an existence check. The failure mode being
 * defended against is a shell that references `/m/assets/index-<hash>.js`
 * which no longer exists — the classic PWA white screen, with no server
 * error and nothing in the logs. "shell.html exists and one asset
 * exists" passes happily in that state. So the guard validates the build
 * marker against what is actually on disk:
 *
 *   1. every asset the Vite manifest recorded is present;
 *   2. every shell variant hashes to what the publisher recorded (catches
 *      a fresh shell paired with stale assets, and the reverse);
 *   3. every `/m/...` URL the shell actually references resolves to a file.
 *
 * (3) is the one that directly tests the white-screen condition.
 *
 * The ordering fix itself is the `@weavestream/mobile` devDependency in
 * this package, which makes pnpm serialise the two builds on every
 * `pnpm -r build` rather than only inside Docker. This guard is what
 * proves the fix held — the race is nondeterministic, so a single green
 * run proves nothing on its own.
 *
 * There is deliberately no environment-variable escape hatch: one that
 * can be left set in CI defeats the entire point.
 */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_DIR = join(WEB, 'mobile-shell');
const PUBLIC_M = join(WEB, 'public', 'm');
const MARKER = join(SHELL_DIR, 'mobile-build.json');

const BUILD_HINT =
  'Run `pnpm --filter @weavestream/mobile build` (or `pnpm build` from the repo root).';

function fail(lines) {
  console.error('\n✖ mobile bundle check failed\n');
  for (const l of [].concat(lines)) console.error(`  ${l}`);
  console.error(`\n  ${BUILD_HINT}\n`);
  process.exit(1);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Map a `/m/...` URL onto its file under apps/web/public/m. */
function urlToPath(url) {
  return join(PUBLIC_M, url.replace(/^\/m\//, ''));
}

async function main() {
  if (!existsSync(MARKER)) {
    fail([
      `No build marker at apps/web/mobile-shell/mobile-build.json.`,
      `The mobile bundle has not been published into apps/web.`,
    ]);
  }

  let marker;
  try {
    marker = JSON.parse(await readFile(MARKER, 'utf8'));
  } catch (err) {
    fail([`Build marker is not valid JSON: ${err.message}`]);
  }

  const problems = [];

  // 0. The marker must actually describe a build.
  //
  // Every check below iterates a collection out of the marker, so a
  // marker of `{}` — valid JSON, empty object — satisfies all of them
  // vacuously and the guard reports success with zero assets and zero
  // variants. That is the exact "looks fine, ships broken" outcome this
  // script exists to prevent, so the shape is validated before anything
  // is iterated.
  const SCHEMA = 1;
  if (marker.schema !== SCHEMA) {
    fail([
      `Build marker schema is ${JSON.stringify(marker.schema)}, expected ${SCHEMA}.`,
      'The publisher and this guard are out of step.',
    ]);
  }
  if (!Array.isArray(marker.assets) || marker.assets.length === 0) {
    problems.push('marker lists no assets — the bundle cannot be empty');
  }
  if (!Array.isArray(marker.referenced) || marker.referenced.length === 0) {
    problems.push('marker records no referenced URLs — the shell must load something');
  }
  if (
    !marker.shells ||
    typeof marker.shells !== 'object' ||
    Object.keys(marker.shells).length === 0
  ) {
    problems.push('marker records no shell variants');
  }
  // The accent set is checked against `uiAccentValues` from
  // `@weavestream/shared`, NOT against the marker's own list. Trusting
  // `marker.accents` lets a truncated or hand-edited marker pass by
  // simply declaring fewer accents than exist — the guard would then
  // green-light a build whose users get a 500 (or the fallback accent)
  // for any palette the publisher happened to skip. The shared enum is
  // the same source the publisher iterates, so this compares the output
  // against the requirement rather than against itself.
  const { uiAccentValues, DEFAULT_UI_ACCENT } = await import(
    '@weavestream/shared'
  );
  const expected = [...uiAccentValues].sort();

  const declared = Array.isArray(marker.accents) ? [...marker.accents].sort() : [];
  if (declared.join(',') !== expected.join(',')) {
    problems.push(
      `marker declares accents [${declared.join(', ') || 'none'}] but this build ` +
        `requires [${expected.join(', ')}]`,
    );
  }

  const shellKeys = marker.shells ? Object.keys(marker.shells).sort() : [];
  if (shellKeys.join(',') !== expected.join(',')) {
    const missing = expected.filter((a) => !shellKeys.includes(a));
    const extra = shellKeys.filter((a) => !expected.includes(a));
    problems.push(
      'shell variants do not cover every accent' +
        (missing.length ? ` — missing: ${missing.join(', ')}` : '') +
        (extra.length ? ` — unexpected: ${extra.join(', ')}` : ''),
    );
  }

  // The handler falls back to this accent when a cookie names one that
  // no longer exists, so a bogus value would 503 those users.
  if (!expected.includes(marker.fallbackAccent)) {
    problems.push(
      `marker fallbackAccent ${JSON.stringify(marker.fallbackAccent)} is not a ` +
        `known accent (expected one of ${expected.join(', ')}; ` +
        `the app default is ${DEFAULT_UI_ACCENT})`,
    );
  }

  if (problems.length) fail(problems);

  // 1. Assets recorded by the Vite manifest.
  for (const asset of marker.assets ?? []) {
    const p = join(PUBLIC_M, asset);
    if (!existsSync(p)) problems.push(`missing asset: public/m/${asset}`);
  }

  // 2. Shell variants match their recorded hash. A mismatch means the
  //    shell and the assets came from different builds.
  for (const [accent, expected] of Object.entries(marker.shells ?? {})) {
    const p = join(SHELL_DIR, `${accent}.html`);
    if (!existsSync(p)) {
      problems.push(`missing shell variant: mobile-shell/${accent}.html`);
      continue;
    }
    const actual = sha256(await readFile(p, 'utf8'));
    if (actual !== expected) {
      problems.push(
        `stale shell variant: mobile-shell/${accent}.html does not match the ` +
          `hash recorded at publish time`,
      );
    }
  }

  // 3. What the shell actually asks the browser to load. This is the
  //    white-screen condition, tested directly.
  for (const url of marker.referenced ?? []) {
    // The web manifest is emitted alongside the assets; icons live in
    // apps/web/public/brand and are not ours to check.
    if (!url.startsWith('/m/')) continue;
    const p = urlToPath(url);
    if (!existsSync(p)) {
      problems.push(`shell references ${url}, which does not exist on disk`);
    } else {
      const s = await stat(p);
      if (s.size === 0) problems.push(`shell references ${url}, which is empty`);
    }
  }

  if (problems.length) fail(problems);

  const n = (marker.assets ?? []).length;
  const v = Object.keys(marker.shells ?? {}).length;
  console.log(`✔ mobile bundle OK — ${n} assets, ${v} shell variants`);
}

main().catch((err) => fail([err.message]));
