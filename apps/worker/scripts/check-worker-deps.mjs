#!/usr/bin/env node
/**
 * Postbuild guard: refuse to ship an `apps/worker` build that loads a package
 * the runner image cannot resolve.
 *
 * ## The shape it guards
 *
 * The worker compiles only its own `src/` into `dist/`. It reaches API code
 * solely through the API's package exports — `require('@weavestream/api/<entry>')`
 * — which Node resolves through the `exports` map in `apps/api/package.json`
 * to a file in `apps/api/dist`. From there, every API file resolves its own
 * imports against `apps/api/node_modules`, and every worker file against
 * `apps/worker/node_modules`. The runner stage of `docker/worker.Dockerfile`
 * copies `dist/`, `package.json` and `node_modules/` for the worker and for
 * each workspace package it loads, plus the root store, and installs each with
 * `pnpm install --prod`.
 *
 * So the rule is: **every package required on the reachable graph is in the
 * `dependencies` of the app that owns the requiring file.** A devDependency
 * passes every local build and test, then is pruned from the image, and the
 * worker dies at boot with MODULE_NOT_FOUND while the queues stop draining.
 *
 * `c614adb` is that outage, found in production. It happened under the
 * previous shape, where the worker compiled `../api/src` into its own `dist`
 * and the compiled API code resolved against the WORKER's dependency list.
 * That shape is gone; the guard stays because the devDependency trap and the
 * cross-package traps below are still invisible to lint, typecheck and tests.
 *
 * ## What else the package boundary adds
 *
 *   - **Unexported subpaths.** The worker's tsconfig maps `@weavestream/api/*`
 *     to the API's `.d.ts` files with `paths`, which knows nothing about the
 *     `exports` map. A new entry file with no `exports` entry typechecks and
 *     dies at boot with ERR_PACKAGE_PATH_NOT_EXPORTED. The walk resolves
 *     through `exports`, exactly as Node does.
 *   - **Split instances.** The API and the worker now each resolve packages
 *     from their own `node_modules`. pnpm gives both the same physical copy
 *     only while their versions and peer sets agree. If they drift, the worker
 *     process loads two `@nestjs/common` (and `@prisma/client`, …): Nest
 *     DI tokens, `instanceof` checks and the pino logger override stop
 *     crossing the boundary, with no error. Every package required from both
 *     sides must resolve to one real directory.
 *
 * ## Why the cheaper implementations do not work
 *
 * **Reading TypeScript source instead of compiled output.** `tsc` erases
 * type-only imports. `express` is imported about ten times in API files the
 * worker reaches and every one is `import type { Request }`; zero survive into
 * `dist`. A source-level guard would demand `express` as a runtime dependency
 * and simply be wrong. Reading `dist` measures what Node will try to resolve.
 *
 * **Checking every file in both `dist` trees rather than the reachable ones.**
 * The worker reaches a minority of the API. The rest legitimately references
 * packages the worker never loads. Reachability is the entire point.
 *
 * **Descending into `node_modules`.** A third-party package's transitive
 * dependencies are declared by its own `package.json` and installed by pnpm
 * from the lockfile. Only first-party edges are followed: relative ones, and
 * `@weavestream/api/<entry>` into the API's `dist`. `@weavestream/db` and
 * `@weavestream/shared` are libraries with their own declared dependencies,
 * and are not walked.
 *
 * ## Invariants
 *
 *   1. The walk actually walked: both `dist/` trees exist, the entry named by
 *      `main` exists, the emit is still CommonJS, and the walk reached more
 *      than the entry and at least one package. See "check 0".
 *   1b. `main` resolves inside `dist/`. A `startsWith('dist/')` test is not
 *      that proof — `dist/../outside.js` passes it.
 *   2. Every relative `require()` on the reachable graph resolves to a real
 *      file inside the requiring app's own `dist/`. An edge leading nowhere
 *      means the walk is blind to part of the graph.
 *   3. Every `@weavestream/api/<entry>` resolves through the `exports` map to
 *      a real file inside `apps/api/dist`.
 *   4. Every bare `require()` names a package in the owning app's
 *      `dependencies`, and no workspace package the runner image leaves
 *      behind.
 *   5. Every package required from both apps resolves to one real directory.
 *
 * ## What this does NOT prove
 *
 *   1. **Static `require()` only.** A computed specifier or an `import()`
 *      hidden from `tsc` is invisible here. `c614adb` took a second outage
 *      on exactly that: `apps/api/src/uploads/uploads.service.ts` once
 *      reached `file-type` through `new Function('return import(...)')`.
 *      It now uses a plain `await import('file-type')`, which `tsc` emits as
 *      a lazy `require('file-type')` (require(esm)) that this walk does see.
 *      Keep dynamic loads few and obvious.
 *   2. **DECLARED, not INSTALLED.** Invariant 4 reads `package.json`, never
 *      `node_modules`. `pnpm install --frozen-lockfile` makes declared imply
 *      installed, which is why declaration is the right thing to assert.
 *
 * There is deliberately no environment-variable escape hatch: one that can be
 * left set in CI defeats the entire point.
 *
 * ## Modes
 *
 *   (default)     the dependency walk above. Chained onto `nest build`, so it
 *                 runs locally, in CI, and inside the Docker build. It reads
 *                 only `apps/worker` and `apps/api`, which that build stage
 *                 copies. The API must be built first.
 *   `--wiring`    the repo-level checks against `docker/worker.Dockerfile`.
 *                 The Docker build context excludes `docker/`, so it runs from
 *                 `pnpm test` rather than from `build`. See `wiringCheck`.
 *   `--self-test` exercises the failure branches against throwaway fixtures,
 *                 because a guard whose failure paths never run is not known
 *                 to work. Also `pnpm test`.
 *
 * Keep the default mode's inputs inside `apps/worker` and `apps/api`. Reaching
 * outside them once cost a red `docker-build`: the guard read
 * `docker/worker.Dockerfile`, which is not in the build context, and ENOENT
 * took the image with it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = resolve(WORKER, '..', 'api');
const DOCKERFILE = resolve(WORKER, '..', '..', 'docker', 'worker.Dockerfile');

const API_PACKAGE = '@weavestream/api';

/**
 * Workspace packages the runner image ships, and the repo directory of each.
 * Any other `@weavestream/*` package resolves fine here (pnpm symlinks it) and
 * is missing in the container.
 *
 * SOURCE OF TRUTH: the `COPY --from=build` block in the runner stage of
 * `docker/worker.Dockerfile`. `--wiring` asserts that block copies `dist/`,
 * `package.json` and `node_modules/` for every entry here.
 */
const SHIPPED_WORKSPACE_PACKAGES = new Map([
  [API_PACKAGE, 'apps/api'],
  ['@weavestream/db', 'packages/db'],
  ['@weavestream/shared', 'packages/shared'],
]);

const BUILD_HINT =
  'Run `pnpm --filter @weavestream/api build` and then `pnpm --filter @weavestream/worker build` — ' +
  'this guard reads both dist/ trees, not src/.';
const DECLARE_HINT =
  'Add each package to "dependencies" in the package.json of the app named above, and run ' +
  '`pnpm install`. Each app resolves packages from its own node_modules.';
const UNSHIPPED_HINT =
  'Stop importing it from code the worker loads, or change the runner stage of ' +
  'docker/worker.Dockerfile to ship it. Adding a dependency will NOT fix this.';
const EXPORT_HINT =
  'Export the entry from apps/api/src/public/ and add it to "exports" in apps/api/package.json.';
const INSTANCE_HINT =
  'Align the version range in apps/api/package.json and apps/worker/package.json, then run ' +
  '`pnpm install` so both resolve one copy.';
const WIRING_HINT =
  'apps/worker/package.json, docker/worker.Dockerfile and this guard are out of step — ' +
  '"main" must name the compiled entry the image runs, and the image must ship every ' +
  'workspace package the worker loads.';

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

/** True when `file` is `dir` itself or anywhere below it. */
function isInside(dir, file) {
  const within = relative(dir, file);
  return !within.startsWith('..') && !isAbsolute(within);
}

/**
 * Resolves `package.json#main` to a real path and proves it lands inside
 * `dist/`.
 *
 * `startsWith('dist/')` is not that proof: `dist/../outside.js` satisfies it
 * and resolves out of the tree the runner image copies. Containment is
 * therefore checked after resolution, not on the raw string.
 */
export function resolveEntry({ workerDir, distDir, main }) {
  if (typeof main !== 'string' || main.length === 0) {
    return { error: [`package.json "main" is ${JSON.stringify(main)}, not a path.`] };
  }
  const entryFile = resolve(workerDir, main);
  if (!isInside(distDir, entryFile) || relative(distDir, entryFile).length === 0) {
    return {
      error: [
        `package.json "main" is ${JSON.stringify(main)}, which resolves to`,
        `${entryFile} — outside dist/, the tree the runner image copies.`,
      ],
    };
  }
  return { entryFile };
}

/**
 * The CommonJS target of one `exports` subpath, or null when the subpath is
 * not exported. Handles the two shapes in use: a string, and a conditions
 * object (`types` is for the compiler and is never what `require` loads).
 */
export function resolveExportTarget(exportsField, subpath) {
  if (exportsField === undefined || exportsField === null) return null;
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : null;
  const pick = (entry) => {
    if (typeof entry === 'string') return entry;
    if (entry === null || typeof entry !== 'object') return null;
    for (const condition of ['require', 'node', 'default']) {
      if (Object.hasOwn(entry, condition)) return pick(entry[condition]);
    }
    return null;
  };
  return Object.hasOwn(exportsField, subpath) ? pick(exportsField[subpath]) : null;
}

/**
 * The entry path is written down in three places that nothing keeps in step:
 * `package.json#main`, the `start` script, and the runner `CMD` in
 * `docker/worker.Dockerfile`. This guard reads the first. If the container
 * executes a different one, the guard audits a dependency graph production
 * never loads and passes while the image is broken.
 *
 * So the three are asserted equal rather than assumed equal. A parse that
 * finds nothing is a failure, not a silent skip: a Dockerfile whose CMD moved
 * to shell form would otherwise disable this check without a word.
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

/**
 * The runner stage must copy `dist/`, `package.json` and `node_modules/` for
 * every workspace package in `SHIPPED_WORKSPACE_PACKAGES`. Without `dist/` the
 * require fails; without `package.json` the `exports` map is gone; without
 * `node_modules/` every package that app's code requires is unresolvable.
 */
export function shippedPackagesCopied({ dockerfile, shipped = SHIPPED_WORKSPACE_PACKAGES }) {
  const problems = [];
  for (const [name, dir] of shipped) {
    for (const part of ['dist', 'package.json', 'node_modules']) {
      const source = `/repo/${dir}/${part}`;
      const re = new RegExp(
        `^COPY\\s+--from=build\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`,
        'm',
      );
      if (!re.test(dockerfile)) {
        problems.push(`docker/worker.Dockerfile does not copy ${source} (${name}).`);
      }
    }
  }
  return problems;
}

/**
 * Packages required from both apps must be one physical copy. `resolveDir`
 * maps (app, package) to a real directory, or null when it is not installed.
 */
export function instancesAgree({ names, resolveDir }) {
  const problems = [];
  for (const name of names) {
    const worker = resolveDir('worker', name);
    const api = resolveDir('api', name);
    if (worker === null || api === null) {
      const missing = worker === null ? 'apps/worker' : 'apps/api';
      problems.push(
        `${name} is required from both apps but is not installed in ${missing}/node_modules`,
      );
    } else if (worker !== api) {
      problems.push(`${name} resolves to two copies:`, `  worker: ${worker}`, `  api:    ${api}`);
    }
  }
  return problems;
}

/**
 * The whole dependency verdict, as a pure function of two `dist/` trees and
 * their manifests. Synchronous on purpose: it makes `--self-test` trivial, and
 * the cost is a few hundred small reads.
 *
 * `apps.worker` and `apps.api` each carry `{ dir, distDir, deps, devDeps,
 * optionalDeps }`; `apps.api` also carries `exports`.
 */
export function analyse({ apps, entryFile, shipped = SHIPPED_WORKSPACE_PACKAGES }) {
  const owners = Object.keys(apps);
  const reached = new Map([[entryFile, 'worker']]);
  const stack = [entryFile];
  const importers = new Map(owners.map((o) => [o, new Map()]));
  const problems = [];
  const unexported = [];

  const visit = (target, owner) => {
    if (target.endsWith('.js') && !reached.has(target)) {
      reached.set(target, owner);
      stack.push(target);
    }
  };

  while (stack.length > 0) {
    const file = stack.pop();
    const owner = reached.get(file);
    const app = apps[owner];
    const where = relative(app.dir, file);
    for (const specifier of requireSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        // Invariant 2.
        const target = resolveRelative(file, specifier);
        if (target === null) {
          problems.push(`${owner}: ${where} requires '${specifier}', which is not on disk`);
        } else if (!isInside(app.distDir, target)) {
          problems.push(
            `${owner}: ${where} requires '${specifier}', which resolves outside its dist/`,
          );
        } else {
          visit(target, owner);
        }
        continue;
      }
      if (isBuiltin(specifier)) continue;
      const name = packageNameOf(specifier);
      const byName = importers.get(owner);
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(where);

      // Invariant 3: follow the worker into the API through `exports`.
      if (name === API_PACKAGE && owner === 'worker' && apps.api) {
        const subpath = `.${specifier.slice(name.length)}`;
        const target = resolveExportTarget(apps.api.exports, subpath);
        const file = target === null ? null : resolve(apps.api.dir, target);
        if (file === null) {
          unexported.push(`${where} requires '${specifier}', which "exports" does not list`);
        } else if (!isInside(apps.api.distDir, file) || !existsSync(file)) {
          problems.push(
            `worker: ${where} requires '${specifier}', which "exports" maps to ` +
              `${relative(apps.api.dir, file)} — not a built file inside apps/api/dist`,
          );
        } else {
          visit(file, 'api');
        }
      }
    }
  }

  // Invariant 4.
  const undeclared = [];
  const unshipped = [];
  for (const owner of owners) {
    const { deps, devDeps = {}, optionalDeps = {} } = apps[owner];
    for (const name of [...importers.get(owner).keys()].sort()) {
      const files = [...importers.get(owner).get(name)].sort();
      if (name.startsWith('@weavestream/') && !shipped.has(name)) {
        unshipped.push({
          owner,
          name,
          note: 'a workspace package the runner image does not copy',
          importers: files,
        });
        continue;
      }
      if (Object.hasOwn(deps, name)) continue;
      let note = 'not declared anywhere in this package';
      if (Object.hasOwn(devDeps, name)) {
        note = 'declared only in devDependencies, which `pnpm install --prod` omits';
      } else if (Object.hasOwn(optionalDeps, name)) {
        // A manifest-contract rule, not a claim about install behaviour:
        // `--prod` DOES install optional dependencies. An unconditional static
        // require() must simply not rest on a package marked optional.
        note =
          'declared only in optionalDependencies, which an unconditional require() must not rest on';
      }
      undeclared.push({ owner, name, note, importers: files });
    }
  }

  // Invariant 5's input: names required from both sides.
  const shared =
    owners.length < 2
      ? []
      : [...importers.get('worker').keys()].filter((n) => importers.get('api').has(n)).sort();

  return { reached, importers, shared, undeclared, unshipped, unexported, problems };
}

function reportGroup(lines, group) {
  for (const { owner, name, note, importers } of group) {
    const more = importers.length > 3 ? ` (+${importers.length - 3} more)` : '';
    lines.push(`${name} in apps/${owner} — ${note}`);
    lines.push(`  required by ${importers.length} reachable file(s)${more}:`);
    for (const f of importers.slice(0, 3)) lines.push(`    ${f}`);
  }
  return lines;
}

function readPackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch (err) {
    fail(
      [`${relative(resolve(WORKER, '..', '..'), dir)}/package.json is unreadable: ${err.message}`],
      WIRING_HINT,
    );
  }
}

function appOf(dir, pkg) {
  return {
    dir,
    distDir: join(dir, 'dist'),
    deps: pkg.dependencies ?? {},
    devDeps: pkg.devDependencies ?? {},
    optionalDeps: pkg.optionalDependencies ?? {},
    exports: pkg.exports,
  };
}

function main() {
  // Check 0, before anything is iterated.
  //
  // Every check below reads the reachable graph, so a walk that finds nothing
  // satisfies all of them vacuously and this script prints a tick having
  // proven nothing. A missing dist/, a missing entry, or an emit that is no
  // longer CommonJS each produce that same silence, so the inputs are asserted
  // here and the walk's yield is asserted immediately after it runs.
  for (const dir of [WORKER, API]) {
    const dist = join(dir, 'dist');
    if (!existsSync(dist) || !statSync(dist).isDirectory()) {
      fail(
        [`${relative(resolve(WORKER, '..'), dist)} does not exist — there is no build to check.`],
        BUILD_HINT,
      );
    }
  }

  const workerPkg = readPackage(WORKER);
  const apiPkg = readPackage(API);
  const apps = { worker: appOf(WORKER, workerPkg), api: appOf(API, apiPkg) };

  const resolved = resolveEntry({
    workerDir: WORKER,
    distDir: apps.worker.distDir,
    main: workerPkg.main,
  });
  if (resolved.error) fail(resolved.error, WIRING_HINT);

  if (Object.keys(apps.worker.deps).length === 0) {
    fail(
      ['apps/worker/package.json declares no "dependencies" — a NestJS worker cannot have none.'],
      WIRING_HINT,
    );
  }

  const { entryFile } = resolved;
  if (!existsSync(entryFile)) {
    fail([`Entry ${workerPkg.main} is missing — the build did not finish.`], BUILD_HINT);
  }
  if (requireSpecifiers(readFileSync(entryFile, 'utf8')).length === 0) {
    fail(
      [
        `${workerPkg.main} contains no static require() calls.`,
        'This guard only understands the CommonJS emit (tsconfig "module": "CommonJS").',
        'If the emit moved to ESM the walk finds nothing and this check silently stops',
        'meaning anything — teach it `import` before letting it pass again.',
      ],
      WIRING_HINT,
    );
  }

  const result = analyse({ apps, entryFile });

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
  if (result.unexported.length > 0) {
    fail(
      [
        'The worker requires an API entry that apps/api/package.json does not export.',
        'It typechecks (tsconfig "paths" ignores "exports") and dies at boot with',
        'ERR_PACKAGE_PATH_NOT_EXPORTED:',
        ...result.unexported,
      ],
      EXPORT_HINT,
    );
  }
  // Check 0, second half: the walk's yield. Both are large in any real build.
  if (result.reached.size < 2) {
    fail(
      [
        `Only ${result.reached.size} file is reachable from ${workerPkg.main} — the walk found nothing.`,
      ],
      BUILD_HINT,
    );
  }
  const packageCount = [...result.importers.values()].reduce((n, m) => n + m.size, 0);
  if (packageCount === 0) {
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
          'but are not in the owning app\'s "dependencies" — the container will exit at boot',
          'with MODULE_NOT_FOUND, and no build or test step will have said so:',
        ],
        result.undeclared,
      ),
      DECLARE_HINT,
    );
  }

  const appDirs = { worker: WORKER, api: API };
  const split = instancesAgree({
    names: result.shared,
    resolveDir: (owner, name) => {
      const dir = join(appDirs[owner], 'node_modules', name);
      return existsSync(dir) ? realpathSync(dir) : null;
    },
  });
  if (split.length > 0) {
    fail(
      [
        'The worker process would load two copies of a package both apps use, so',
        'classes, DI tokens and logger overrides stop matching across the boundary:',
        ...split,
      ],
      INSTANCE_HINT,
    );
  }

  const count = (owner) => [...result.reached.values()].filter((o) => o === owner).length;
  console.log(
    `  ${count('worker')} worker and ${count('api')} API compiled files are reachable from ` +
      `${workerPkg.main}; ${result.shared.length} packages are used from both and resolve to one copy.`,
  );
  console.log(
    `✓ worker deps OK — all ${packageCount} package requirements on that graph are declared in ` +
      'the owning app\'s "dependencies"',
  );
}

/**
 * Repo-level checks against `docker/worker.Dockerfile`: the three copies of
 * the entry path agree, and the runner stage ships every workspace package
 * the worker loads.
 *
 * Deliberately NOT part of `main()`. `main()` runs inside
 * `docker/worker.Dockerfile`'s build stage, whose context does **not** include
 * `docker/` — so reading the Dockerfile there fails with ENOENT and takes the
 * whole image build with it. It did, once. Drift fails CI here, on every push,
 * long before an image is built.
 */
function wiringCheck() {
  const pkg = readPackage(WORKER);
  let dockerfile;
  try {
    dockerfile = readFileSync(DOCKERFILE, 'utf8');
  } catch (err) {
    // A hard failure, not a skip. This mode exists to read that file; if it is
    // gone, the check is not "inapplicable", it is broken.
    fail([`Could not read docker/worker.Dockerfile: ${err.message}`], WIRING_HINT);
  }

  const disagreements = [
    ...entryPointsAgree({ main: pkg.main, dockerfile, startScript: pkg.scripts?.start }),
    ...shippedPackagesCopied({ dockerfile }),
  ];
  if (disagreements.length > 0) fail(disagreements, WIRING_HINT);

  console.log(
    `✓ worker entry wiring — package.json "main", the start script, and the ` +
      `Dockerfile CMD all name ${pkg.main}; the image ships ` +
      `${[...SHIPPED_WORKSPACE_PACKAGES.keys()].join(', ')}`,
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
  /** A fixture pair: `<case>/worker/dist` and `<case>/api/dist`. */
  const fixture = (name, { worker = {}, api = {} } = {}) => {
    const app = (which, extra) => ({
      dir: join(root, name, which),
      distDir: join(root, name, which, 'dist'),
      deps: {},
      ...extra,
    });
    return { worker: app('worker', worker), api: app('api', api) };
  };
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok });

  try {
    // 1. An undeclared bare package is reported, with its owner and importer.
    const entry1 = write('a/worker/dist/main.js', 'require("./svc.js");');
    write('a/worker/dist/svc.js', 'require("sharp"); require("node:fs"); require("bullmq");');
    const r1 = analyse({
      apps: fixture('a', { worker: { deps: { bullmq: '^5' } } }),
      entryFile: entry1,
    });
    check(
      'reports an undeclared package with its owner and importer',
      r1.undeclared.length === 1 &&
        r1.undeclared[0].name === 'sharp' &&
        r1.undeclared[0].owner === 'worker' &&
        r1.undeclared[0].importers.includes('dist/svc.js') &&
        r1.problems.length === 0,
    );
    check('does not flag a declared package or a builtin', r1.importers.get('worker').size === 2);

    // 2. A relative edge pointing at a missing file is reported.
    const entry2 = write('b/worker/dist/main.js', 'require("./gone.js");');
    const r2 = analyse({ apps: fixture('b'), entryFile: entry2 });
    check(
      'reports a relative edge that resolves nowhere',
      r2.problems.length === 1 && r2.problems[0].includes('not on disk'),
    );

    // 3. A clean worker → API graph reports nothing.
    const entry3 = write(
      'c/worker/dist/main.js',
      'require("./dep.js"); require("bullmq"); require("@weavestream/api/runtime");',
    );
    write('c/worker/dist/dep.js', 'require("node:path");');
    write('c/api/dist/public/runtime.js', 'require("../redis.js"); require("bullmq");');
    write('c/api/dist/redis.js', 'require("ioredis");');
    const r3 = analyse({
      apps: fixture('c', {
        worker: { deps: { bullmq: '^5', '@weavestream/api': 'workspace:*' } },
        api: {
          deps: { bullmq: '^5', ioredis: '^5' },
          exports: {
            './runtime': {
              types: './dist/public/runtime.d.ts',
              default: './dist/public/runtime.js',
            },
          },
        },
      }),
      entryFile: entry3,
    });
    check(
      'reports nothing for a clean graph, and walks into the API through "exports"',
      r3.undeclared.length === 0 &&
        r3.unshipped.length === 0 &&
        r3.unexported.length === 0 &&
        r3.problems.length === 0 &&
        r3.reached.size === 4 &&
        [...r3.reached.values()].filter((o) => o === 'api').length === 2,
    );
    check('lists the packages both apps require', r3.shared.join() === 'bullmq');

    // 4. An API file is judged against the API's dependencies, not the worker's.
    const entry4 = write('d/worker/dist/main.js', 'require("@weavestream/api/runtime");');
    write('d/api/dist/public/runtime.js', 'require("argon2");');
    const r4 = analyse({
      apps: fixture('d', {
        worker: { deps: { argon2: '^0', '@weavestream/api': 'workspace:*' } },
        api: { exports: { './runtime': './dist/public/runtime.js' } },
      }),
      entryFile: entry4,
    });
    check(
      "judges an API file against the API's dependencies, not the worker's",
      r4.undeclared.length === 1 &&
        r4.undeclared[0].owner === 'api' &&
        r4.undeclared[0].name === 'argon2',
    );

    // 5. A subpath "exports" does not list, and the bare package, are rejected.
    const entry5 = write(
      'e/worker/dist/main.js',
      'require("@weavestream/api/internal"); require("@weavestream/api");',
    );
    const r5 = analyse({
      apps: fixture('e', {
        worker: { deps: { '@weavestream/api': 'workspace:*' } },
        api: { exports: { './runtime': './dist/public/runtime.js' } },
      }),
      entryFile: entry5,
    });
    check('rejects an API subpath that "exports" does not list', r5.unexported.length === 2);

    // 6. An exported target that is not built is an edge leading nowhere.
    const entry6 = write('f/worker/dist/main.js', 'require("@weavestream/api/runtime");');
    const r6 = analyse({
      apps: fixture('f', {
        worker: { deps: { '@weavestream/api': 'workspace:*' } },
        api: { exports: { './runtime': './dist/public/runtime.js' } },
      }),
      entryFile: entry6,
    });
    check('reports an exported API entry that was never built', r6.problems.length === 1);

    // 7. A relative edge from the API that escapes the API's dist/.
    const entry7 = write('g/worker/dist/main.js', 'require("@weavestream/api/runtime");');
    write('g/api/dist/public/runtime.js', 'require("../../src/raw.js");');
    write('g/api/src/raw.js', '');
    const r7 = analyse({
      apps: fixture('g', {
        worker: { deps: { '@weavestream/api': 'workspace:*' } },
        api: { exports: { './runtime': './dist/public/runtime.js' } },
      }),
      entryFile: entry7,
    });
    check(
      "reports an API edge that leaves the API's dist/",
      r7.problems.length === 1 && r7.problems[0].includes('outside its dist/'),
    );

    // 8. An unshipped workspace package fails even though it IS declared.
    const entry8 = write('h/worker/dist/main.js', 'require("@weavestream/config/x.js");');
    const r8 = analyse({
      apps: fixture('h', { worker: { deps: { '@weavestream/config': 'workspace:*' } } }),
      entryFile: entry8,
    });
    check(
      'rejects an unshipped workspace package despite it being declared',
      r8.unshipped.length === 1 &&
        r8.unshipped[0].name === '@weavestream/config' &&
        r8.undeclared.length === 0,
    );

    // 9. devDependencies and optionalDependencies get their own wording.
    const entry9 = write('i/worker/dist/main.js', 'require("supertest"); require("fsevents");');
    const r9 = analyse({
      apps: fixture('i', {
        worker: {
          deps: { bullmq: '^5' },
          devDeps: { supertest: '^7' },
          optionalDeps: { fsevents: '^2' },
        },
      }),
      entryFile: entry9,
    });
    check(
      'distinguishes devDependencies from optionalDependencies',
      r9.undeclared.length === 2 &&
        r9.undeclared.find((u) => u.name === 'supertest').note.includes('devDependencies') &&
        r9.undeclared.find((u) => u.name === 'fsevents').note.includes('optionalDependencies'),
    );

    // 10. Two physical copies of a package both apps use.
    const dirs = { worker: { a: '/s/a@1', b: '/s/b@1' }, api: { a: '/s/a@1', b: '/s/b@2' } };
    const split = instancesAgree({
      names: ['a', 'b', 'c'],
      resolveDir: (owner, name) => dirs[owner][name] ?? null,
    });
    check(
      'reports a package that resolves to two copies, and one not installed',
      split.some((l) => l.startsWith('b resolves to two copies')) &&
        split.some((l) => l.startsWith('c is required from both apps')) &&
        !split.some((l) => l.startsWith('a ')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // 11. `main` must resolve INSIDE dist/, which a string prefix does not prove.
  const entryCases = [
    ['dist/main.js', false],
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

  // 12. The three copies of the entry path must agree.
  const good = {
    main: 'dist/main.js',
    dockerfile: 'ENTRYPOINT ["/x.sh"]\nCMD ["node", "dist/main.js"]\n',
    startScript: 'node dist/main.js',
  };
  check('accepts three entry paths that agree', entryPointsAgree(good).length === 0);
  check(
    'catches a Dockerfile CMD that drifted from main',
    entryPointsAgree({ ...good, dockerfile: 'CMD ["node", "dist/worker/src/main.js"]\n' }).length >
      0,
  );
  check(
    'catches a start script that drifted from main',
    entryPointsAgree({ ...good, startScript: 'node dist/worker/src/main.js' }).length > 0,
  );
  check(
    'fails rather than skips when the CMD cannot be parsed',
    entryPointsAgree({ ...good, dockerfile: 'CMD node dist/main.js\n' }).length > 0,
  );
  check(
    'ignores the indented shell-form HEALTHCHECK CMD above the real one',
    entryPointsAgree({
      ...good,
      dockerfile:
        'HEALTHCHECK --interval=30s \\\n  CMD node -e "process.exit(0)" || exit 1\n' +
        'CMD ["node", "dist/main.js"]\n',
    }).length === 0,
  );

  // 13. The runner stage ships every workspace package the worker loads.
  const shipped = new Map([['@weavestream/api', 'apps/api']]);
  const copies = (parts) =>
    parts.map((p) => `COPY --from=build /repo/apps/api/${p} ./apps/api/${p}`).join('\n') + '\n';
  check(
    'accepts a runner stage that ships dist, package.json and node_modules',
    shippedPackagesCopied({ dockerfile: copies(['dist', 'package.json', 'node_modules']), shipped })
      .length === 0,
  );
  check(
    'catches a runner stage that leaves out a shipped package part',
    shippedPackagesCopied({ dockerfile: copies(['dist', 'package.json']), shipped }).length === 1,
  );

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
else if (process.argv.includes('--wiring')) wiringCheck();
else main();
