#!/usr/bin/env node
/**
 * Postbuild guard: refuse to ship an `apps/worker` build that loads a package
 * `apps/worker/package.json` does not declare.
 *
 * ## The shape of the bug
 *
 * This app's tsconfig `include` names `../api/src` alongside `src`, so
 * `nest build` compiles a second app into this one's output: `dist/` holds
 * `worker/src` AND `api/src`. The runner stage of `docker/worker.Dockerfile`
 * copies `apps/worker/dist`, `apps/worker/node_modules`, the two `packages/*`
 * trees and the root store — it never copies `apps/api/node_modules`. Every
 * compiled API file therefore resolves its imports against the WORKER's
 * dependency list, and a package only `apps/api` declares is unresolvable at
 * runtime no matter how cleanly it built.
 *
 * Most of that compiled API code is never loaded, which is what makes the
 * failure quiet rather than immediate. The undeclared packages
 * (`@nestjs/throttler`, `class-validator`, `argon2`, `jose`, `qrcode`) all sit
 * in the unreachable majority. Nothing breaks until one import moves a file
 * across that line — and nine API controllers are already on the worker's
 * graph, so adding `@Throttle()` to any of them is enough. The worker then
 * dies at boot with MODULE_NOT_FOUND and the queues stop draining.
 *
 * `c614adb` is that outage, found in production and fixed by hand: six
 * packages became reachable at once when the reconstruction writers were wired
 * into the worker. This is the cheap standing version of that fix — it walks
 * the module graph instead of executing it, so it costs a second and needs no
 * container.
 *
 * Nothing else in CI can catch this. Lint, typecheck and `pnpm -r test` never
 * look at resolution, and the `docker-build` job builds the worker image
 * without ever running it.
 *
 * ## Why the cheaper implementations do not work
 *
 * **Reading TypeScript source instead of compiled output.** `tsc` erases
 * type-only imports. `express` is imported about ten times in the reachable
 * API files and every one is `import type { Request }`; zero survive into
 * `dist`. A source-level guard would demand `express` as a runtime dependency
 * and simply be wrong. Reading `dist` measures what Node will try to resolve.
 *
 * **Checking every file in `dist` rather than the reachable ones.** The
 * unreachable majority legitimately references packages this worker never
 * loads. Failing on those would demand real dependencies for code that never
 * runs, the list would be dismissed as noise, and the guard would be deleted.
 * Reachability is the entire point.
 *
 * **Descending into `node_modules`.** A third-party package's transitive
 * dependencies are declared by its own `package.json` and installed by pnpm
 * from the lockfile. Only first-party relative edges are followed here.
 *
 * ## Invariants
 *
 *   1. The walk actually walked: `dist/` exists, the entry named by `main`
 *      exists, the emit is still CommonJS, and the walk reached more than the
 *      entry and at least one package. See "check 0".
 *   1b. The entry inspected is the entry the container runs. `main` must
 *      resolve inside `dist/`, and must equal both the `start` script and the
 *      runner `CMD` in `docker/worker.Dockerfile`. Three unlinked copies of
 *      that path exist; if they drift, this guard audits a graph production
 *      never loads and passes while the image is broken.
 *   2. Every relative `require()` on the reachable graph resolves to a real
 *      file inside `dist/` — the only tree the runner image copies. An edge
 *      leading nowhere means the walk is blind to part of the graph, and every
 *      count below it is an undercount.
 *   3. Every bare `require()` on the reachable graph names a package in this
 *      app's `dependencies`, and is not a workspace package the runner image
 *      leaves behind.
 *
 * ## What this does NOT prove
 *
 *   1. **Static `require()` only.** `apps/api/src/uploads/uploads.service.ts`
 *      reaches `file-type` through `new Function('return import("file-type")')`,
 *      deliberately, to keep a real ESM import alive across the CommonJS
 *      boundary. That is invisible here, as is any other computed specifier.
 *      `c614adb` took a second outage on exactly that file after the
 *      boot-time modules were fixed. Keep dynamic loads few and obvious.
 *   2. **DECLARED, not INSTALLED.** This reads `package.json` and never
 *      `node_modules`. `pnpm install --frozen-lockfile` makes declared imply
 *      installed, which is why declaration is the right thing to assert — but
 *      a package declared and never installed still passes.
 *
 * There is deliberately no environment-variable escape hatch: one that can be
 * left set in CI defeats the entire point.
 *
 * Run `--self-test` to exercise the failure branches against throwaway
 * fixtures. `apps/worker`'s `test` script does this, because a guard whose
 * failure paths never run is not known to work.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(WORKER, 'dist');
const PKG = join(WORKER, 'package.json');
const DOCKERFILE = resolve(WORKER, '..', '..', 'docker', 'worker.Dockerfile');

/**
 * Workspace packages that `apps/worker` declares but the runner image does not
 * contain. `apps/worker/node_modules/@weavestream/api` is a symlink to
 * `apps/api`, and the runner stage of `docker/worker.Dockerfile` copies the
 * worker, `packages/db` and `packages/shared` trees — never `apps/api`. So a
 * declaration check alone would accept `require('@weavestream/api/...')` and
 * still ship an image that dies at boot.
 *
 * SOURCE OF TRUTH: the `COPY --from=build` block in the runner stage of
 * `docker/worker.Dockerfile`. If that block starts copying `apps/api`, this
 * set is wrong and the check stops meaning anything. Keep the two in step.
 */
const UNSHIPPED_WORKSPACE_PACKAGES = new Set(['@weavestream/api']);

const BUILD_HINT =
  'Run `pnpm --filter @weavestream/worker build` — this guard reads dist/, not src/.';
const DECLARE_HINT =
  'Add each package to "dependencies" in apps/worker/package.json and run `pnpm install`. ' +
  'Declaring it in apps/api does not help: the runner image never copies apps/api/node_modules.';
const UNSHIPPED_HINT =
  'Stop importing it from code the worker loads, or change the runner stage of ' +
  'docker/worker.Dockerfile to ship it. Adding a dependency will NOT fix this.';
const WIRING_HINT =
  'apps/worker/package.json and this guard are out of step — "main" must name the ' +
  'compiled entry the image runs (see CMD in docker/worker.Dockerfile).';

function fail(lines, hint = DECLARE_HINT) {
  console.error('\n✖ worker dependency check failed\n');
  for (const l of [].concat(lines)) console.error(`  ${l}`);
  console.error(`\n  ${hint}\n`);
  process.exit(1);
}

const BUILTINS = new Set(builtinModules);

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** `node:` prefixed, or a bare builtin such as `dns/promises`. */
function isBuiltin(specifier) {
  return specifier.startsWith('node:') || BUILTINS.has(packageNameOf(specifier));
}

/**
 * Every static `require('...')` in a compiled file.
 *
 * The lookbehind keeps member calls (`foo.require(...)`) and bundler shims
 * (`__webpack_require__(...)`) out. Computed forms are skipped by
 * construction — that is limitation 1, not an oversight. The literal lives
 * inside the function so no `lastIndex` is shared between calls.
 */
function requireSpecifiers(source) {
  const re = /(?<![\w$.])require\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  return [...source.matchAll(re)].map((m) => m[2]);
}

/** Node's CommonJS lookup minus node_modules: exact, +.js, +.json, /index.js. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.json`, join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The whole verdict, as a pure function of a directory and three dependency
 * maps. Synchronous on purpose: it makes `--self-test` trivial, and the cost
 * is a few hundred small reads.
 */
/**
 * Resolves `package.json#main` to a real path and proves it lands inside
 * `dist/`.
 *
 * `startsWith('dist/')` is not that proof: `dist/../outside.js` satisfies it
 * and resolves out of the tree the runner image copies. Containment is
 * therefore checked after resolution, not on the raw string. Everything this
 * guard concludes is scoped to the graph reachable from this one file, so an
 * entry outside `dist/` would have it auditing something the image does not
 * ship.
 */
export function resolveEntry({ workerDir, distDir, main }) {
  if (typeof main !== 'string' || main.length === 0) {
    return { error: [`package.json "main" is ${JSON.stringify(main)}, not a path.`] };
  }
  const entryFile = resolve(workerDir, main);
  const within = relative(distDir, entryFile);
  if (within.startsWith('..') || isAbsolute(within) || within.length === 0) {
    return {
      error: [
        `package.json "main" is ${JSON.stringify(main)}, which resolves to`,
        `${entryFile} — outside dist/, the only tree the runner image copies.`,
      ],
    };
  }
  return { entryFile };
}

/**
 * The entry path is written down in three places that nothing keeps in step:
 * `package.json#main`, the `start` script, and the runner `CMD` in
 * `docker/worker.Dockerfile`. This guard reads the first. If the container
 * executes a different one, the guard audits a dependency graph production
 * never loads and passes while the image is broken — the precise failure it
 * exists to prevent, reintroduced one level up.
 *
 * So the three are asserted equal rather than assumed equal. A parse that
 * finds nothing is a failure, not a silent skip: a Dockerfile whose CMD moved
 * to shell form would otherwise disable this check without a word.
 *
 * The duplication itself is the real defect. `CMD ["node", "."]` would let
 * Node follow `main` and delete two of the three copies — deliberately not
 * done here, because it changes how the container starts and the image
 * cannot be built on this machine to prove it.
 */
export function entryPointsAgree({ main, dockerfile, startScript }) {
  const problems = [];

  // Anchored at line start so the indented shell-form HEALTHCHECK `CMD` above
  // it cannot match.
  const cmd = /^CMD\s*\[\s*"node"\s*,\s*"([^"]+)"\s*\]/m.exec(dockerfile);
  if (cmd === null) {
    problems.push(
      'Could not find `CMD ["node", "<entry>"]` in docker/worker.Dockerfile.',
      'This guard can no longer prove it inspects the file the container runs.',
    );
  } else if (cmd[1] !== main) {
    problems.push(
      `docker/worker.Dockerfile runs ${JSON.stringify(cmd[1])} but package.json`,
      `"main" is ${JSON.stringify(main)} — this guard would audit the wrong graph.`,
    );
  }

  const start = /^node\s+(\S+)\s*$/.exec(startScript ?? '');
  if (start === null) {
    problems.push(
      `package.json "start" is ${JSON.stringify(startScript)}, which is not`,
      '`node <entry>` — it can no longer be compared with "main".',
    );
  } else if (start[1] !== main) {
    problems.push(
      `package.json "start" runs ${JSON.stringify(start[1])} but "main" is`,
      `${JSON.stringify(main)}.`,
    );
  }

  return problems;
}

export function analyse({ distDir, entryFile, deps, devDeps = {}, optionalDeps = {} }) {
  const shipped = readdirSync(distDir, { recursive: true }).filter((p) =>
    String(p).endsWith('.js'),
  );
  const reached = new Set([entryFile]);
  const stack = [entryFile];
  const importers = new Map();
  const problems = [];

  while (stack.length > 0) {
    const file = stack.pop();
    for (const specifier of requireSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        // Bare: record the package and stop. node_modules is never descended
        // into — a third-party package's own transitive dependencies are its
        // package.json's problem and pnpm's to install.
        if (isBuiltin(specifier)) continue;
        const name = packageNameOf(specifier);
        if (!importers.has(name)) importers.set(name, new Set());
        importers.get(name).add(relative(distDir, file));
        continue;
      }
      // Invariant 2.
      const target = resolveRelative(file, specifier);
      if (target === null) {
        problems.push(`${relative(distDir, file)} requires '${specifier}', which is not on disk`);
        continue;
      }
      if (relative(distDir, target).startsWith('..')) {
        problems.push(
          `${relative(distDir, file)} requires '${specifier}', which resolves outside dist/`,
        );
        continue;
      }
      if (target.endsWith('.js') && !reached.has(target)) {
        reached.add(target);
        stack.push(target);
      }
    }
  }

  // Invariant 3.
  const undeclared = [];
  const unshipped = [];
  for (const name of [...importers.keys()].sort()) {
    const where = [...importers.get(name)].sort();
    if (UNSHIPPED_WORKSPACE_PACKAGES.has(name)) {
      unshipped.push({
        name,
        note: 'a workspace package the runner image does not copy',
        importers: where,
      });
      continue;
    }
    if (Object.hasOwn(deps, name)) continue;
    let note = 'not declared anywhere in this package';
    if (Object.hasOwn(devDeps, name)) {
      note = 'declared only in devDependencies, which `pnpm install --prod` omits';
    } else if (Object.hasOwn(optionalDeps, name)) {
      // Note this is a manifest-contract rule, not a claim about install
      // behaviour: `--prod` DOES install optional dependencies (omitting them
      // needs `--no-optional`). An unconditional static require() must simply
      // not rest on a package the manifest itself marks optional to install.
      note =
        'declared only in optionalDependencies, which an unconditional require() must not rest on';
    }
    undeclared.push({ name, note, importers: where });
  }

  return { shipped, reached, packages: importers, undeclared, unshipped, problems };
}

function reportGroup(lines, group) {
  for (const { name, note, importers } of group) {
    const more = importers.length > 3 ? ` (+${importers.length - 3} more)` : '';
    lines.push(`${name} — ${note}`);
    lines.push(`  required by ${importers.length} reachable file(s)${more}:`);
    for (const f of importers.slice(0, 3)) lines.push(`    ${f}`);
  }
  return lines;
}

function main() {
  // Check 0, before anything is iterated.
  //
  // Every check below reads the reachable graph, so a walk that finds nothing
  // satisfies all of them vacuously and this script prints a tick having
  // proven nothing — the exact "looks fine, ships broken" outcome it exists to
  // prevent. A missing dist/, a missing entry, or an emit that is no longer
  // CommonJS each produce that same silence, so the inputs are asserted here
  // and the walk's yield is asserted immediately after it runs.
  if (!existsSync(DIST) || !statSync(DIST).isDirectory()) {
    fail(['apps/worker/dist does not exist — there is no build to check.'], BUILD_HINT);
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  } catch (err) {
    fail([`apps/worker/package.json is not valid JSON: ${err.message}`], WIRING_HINT);
  }

  const resolved = resolveEntry({ workerDir: WORKER, distDir: DIST, main: pkg.main });
  if (resolved.error) fail(resolved.error, WIRING_HINT);

  // Before trusting `main`, prove the container runs the same file. Otherwise
  // everything below audits a graph production never loads.
  let dockerfile;
  try {
    dockerfile = readFileSync(DOCKERFILE, 'utf8');
  } catch (err) {
    fail([`Could not read docker/worker.Dockerfile: ${err.message}`], WIRING_HINT);
  }
  const disagreements = entryPointsAgree({
    main: pkg.main,
    dockerfile,
    startScript: pkg.scripts?.start,
  });
  if (disagreements.length > 0) fail(disagreements, WIRING_HINT);

  const deps = pkg.dependencies;
  if (!deps || typeof deps !== 'object' || Object.keys(deps).length === 0) {
    fail(
      ['package.json declares no "dependencies" — a NestJS worker cannot have none.'],
      WIRING_HINT,
    );
  }

  const { entryFile } = resolved;
  if (!existsSync(entryFile)) {
    fail([`Entry ${pkg.main} is missing — the build did not finish.`], BUILD_HINT);
  }
  if (requireSpecifiers(readFileSync(entryFile, 'utf8')).length === 0) {
    fail(
      [
        `${pkg.main} contains no static require() calls.`,
        'This guard only understands the CommonJS emit (tsconfig "module": "CommonJS").',
        'If the emit moved to ESM the walk finds nothing and this check silently stops',
        'meaning anything — teach it `import` before letting it pass again.',
      ],
      WIRING_HINT,
    );
  }

  const result = analyse({
    distDir: DIST,
    entryFile,
    deps,
    devDeps: pkg.devDependencies ?? {},
    optionalDeps: pkg.optionalDependencies ?? {},
  });

  if (result.problems.length > 0) {
    fail(
      [
        'The compiled graph has edges leading nowhere, so this walk saw only part of it',
        'and anything it reports would be an undercount:',
        ...result.problems,
      ],
      BUILD_HINT,
    );
  }
  // Check 0, second half: the walk's yield. Both are large in any real build.
  if (result.reached.size < 2) {
    fail(
      [`Only ${result.reached.size} file is reachable from ${pkg.main} — the walk found nothing.`],
      BUILD_HINT,
    );
  }
  if (result.packages.size === 0) {
    fail(
      ['The reachable graph requires no packages at all — a NestJS entry always does.'],
      BUILD_HINT,
    );
  }

  if (result.unshipped.length > 0) {
    fail(
      reportGroup(
        [
          'Code the worker actually loads requires a workspace package that is NOT in the',
          'runner image. It resolves fine here and dies at boot in the container:',
        ],
        result.unshipped,
      ),
      UNSHIPPED_HINT,
    );
  }
  if (result.undeclared.length > 0) {
    fail(
      reportGroup(
        [
          `${result.undeclared.length} package(s) are required by code the worker actually loads`,
          'but are not in its "dependencies" — the container will exit at boot with',
          'MODULE_NOT_FOUND, and no build or test step will have said so:',
        ],
        result.undeclared,
      ),
      DECLARE_HINT,
    );
  }

  const dead = result.shipped.length - result.reached.size;
  console.log(
    `  ${result.reached.size} of ${result.shipped.length} compiled files are reachable from ` +
      `${pkg.main}; ${dead} are compiled in but never loaded.`,
  );
  console.log(
    `✓ worker deps OK — all ${result.packages.size} packages required across those ` +
      `${result.reached.size} reachable files are declared in apps/worker/package.json "dependencies"`,
  );
}

/**
 * Exercises the failure branches. A normal build only ever takes the success
 * path, so without this the reporting below `analyse` could rot unnoticed.
 */
function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'worker-deps-'));
  const write = (rel, body) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok });

  try {
    // 1. An undeclared bare package is reported, with its importer.
    const entry1 = write('a/main.js', 'require("./svc.js");');
    write('a/svc.js', 'require("sharp"); require("node:fs"); require("bullmq");');
    const r1 = analyse({ distDir: join(root, 'a'), entryFile: entry1, deps: { bullmq: '^5' } });
    check(
      'reports an undeclared package with its importer',
      r1.undeclared.length === 1 &&
        r1.undeclared[0].name === 'sharp' &&
        r1.undeclared[0].importers.includes('svc.js') &&
        r1.problems.length === 0,
    );
    check('does not flag a declared package or a builtin', r1.packages.size === 2);

    // 2. A relative edge pointing at a missing file is reported.
    const entry2 = write('b/main.js', 'require("./gone.js");');
    const r2 = analyse({ distDir: join(root, 'b'), entryFile: entry2, deps: {} });
    check(
      'reports a relative edge that resolves nowhere',
      r2.problems.length === 1 && r2.problems[0].includes('not on disk'),
    );

    // 3. A tree whose every requirement is declared reports nothing.
    const entry3 = write('c/main.js', 'require("./dep.js"); require("bullmq");');
    write('c/dep.js', 'require("node:path");');
    const r3 = analyse({ distDir: join(root, 'c'), entryFile: entry3, deps: { bullmq: '^5' } });
    check(
      'reports nothing when every requirement is declared',
      r3.undeclared.length === 0 &&
        r3.unshipped.length === 0 &&
        r3.problems.length === 0 &&
        r3.reached.size === 2,
    );

    // 4. The unshipped-workspace branch fires even though the package IS declared.
    const entry4 = write('d/main.js', 'require("@weavestream/api/dist/thing.js");');
    const r4 = analyse({
      distDir: join(root, 'd'),
      entryFile: entry4,
      deps: { '@weavestream/api': 'workspace:*' },
    });
    check(
      'rejects an unshipped workspace package despite it being declared',
      r4.unshipped.length === 1 &&
        r4.unshipped[0].name === '@weavestream/api' &&
        r4.undeclared.length === 0,
    );

    // 5. devDependencies and optionalDependencies get their own wording.
    const entry5 = write('e/main.js', 'require("supertest"); require("fsevents");');
    const r5 = analyse({
      distDir: join(root, 'e'),
      entryFile: entry5,
      deps: { bullmq: '^5' },
      devDeps: { supertest: '^7' },
      optionalDeps: { fsevents: '^2' },
    });
    check(
      'distinguishes devDependencies from optionalDependencies',
      r5.undeclared.length === 2 &&
        r5.undeclared.find((u) => u.name === 'supertest').note.includes('devDependencies') &&
        r5.undeclared.find((u) => u.name === 'fsevents').note.includes('optionalDependencies'),
    );
    // 6. `main` must resolve INSIDE dist/, which a string prefix does not prove.
    const entryCases = [
      ['dist/worker/src/main.js', false],
      // Satisfies startsWith('dist/') and lands outside the tree the image copies.
      ['dist/../outside.js', true],
      ['../elsewhere/main.js', true],
      [undefined, true],
    ];
    check(
      'rejects a `main` that resolves outside dist/, prefix notwithstanding',
      entryCases.every(
        ([main, shouldFail]) =>
          Boolean(resolveEntry({ workerDir: '/w', distDir: '/w/dist', main }).error) === shouldFail,
      ),
    );

    // 7. The three copies of the entry path must agree.
    const good = {
      main: 'dist/worker/src/main.js',
      dockerfile: 'ENTRYPOINT ["/x.sh"]\nCMD ["node", "dist/worker/src/main.js"]\n',
      startScript: 'node dist/worker/src/main.js',
    };
    check('accepts three entry paths that agree', entryPointsAgree(good).length === 0);
    check(
      'catches a Dockerfile CMD that drifted from main',
      entryPointsAgree({
        ...good,
        dockerfile: 'CMD ["node", "dist/main.js"]\n',
      }).length > 0,
    );
    check(
      'catches a start script that drifted from main',
      entryPointsAgree({ ...good, startScript: 'node dist/main.js' }).length > 0,
    );
    check(
      'fails rather than skips when the CMD cannot be parsed',
      entryPointsAgree({ ...good, dockerfile: 'CMD node dist/worker/src/main.js\n' }).length > 0,
    );
    check(
      'ignores the indented shell-form HEALTHCHECK CMD above the real one',
      entryPointsAgree({
        ...good,
        dockerfile:
          'HEALTHCHECK --interval=30s \\\n  CMD node -e "process.exit(0)" || exit 1\n' +
          'CMD ["node", "dist/worker/src/main.js"]\n',
      }).length === 0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    fail(
      [
        'The guard no longer detects what it exists to detect:',
        ...failed.map((c) => `FAILED: ${c.name}`),
      ],
      'Fix `analyse` in this file. Do not relax the self-test to make it pass.',
    );
  }
  console.log(`✓ worker deps self-test — ${checks.length} failure-path checks hold`);
}

if (process.argv.includes('--self-test')) selfTest();
else main();
