/** The `test` script in package.json starts Jest with
 *  `node --no-sparkplug` instead of the `jest` bin. Do not simplify it
 *  back to `jest`.
 *
 *  Node 24.18.0 (V8 13.6.233.17) segfaults a worker in roughly 1 run in
 *  12. A Sparkplug prologue stack check finalizes incremental marking,
 *  and the mark phase then walks the not-yet-initialized baseline frame
 *  as if every slot held a tagged pointer:
 *  `ClearStaleLeftTrimmedPointerVisitor` reads a garbage word and
 *  dereferences it (SIGSEGV at 0x6 / 0xe). All 27 crashes seen carried
 *  that identical stack. The suite that dies is whichever one the doomed
 *  worker held, which is why every one of them passes in isolation.
 *
 *  `--no-sparkplug` removes that frame type from the crash stack: 0
 *  crashes in 60 runs, and 0 in 24 runs under
 *  `--stress-incremental-marking`, a flag that lifts the unmitigated rate
 *  to 58%. It costs nothing measurable (~2.1s either way) — Sparkplug
 *  does not repay its own tier-up inside a 2-second process. jest-worker
 *  forwards the parent's execArgv to each worker, so the flag must sit on
 *  the `node` command line; NODE_OPTIONS refuses it.
 *
 *  Pinning `maxWorkers` does NOT fix this (4 workers: 6/12, 2 workers:
 *  3/12), and neither does moving the jsdom specs into their own project
 *  — the 53 jsdom specs crash 7/12 on their own. apps/web holds the same
 *  latent bug (2/12 when amplified) and only stays quiet because 29 jsdom
 *  specs sit below the threshold. Revisit when Node ships a V8 later than
 *  13.6.233.17.
 */

/** Mirrors apps/web's setup: Jest 30 + ts-jest, no vitest anywhere in
 *  this monorepo. Default environment is node; component/auth specs opt
 *  into jsdom with a `@jest-environment jsdom` docblock, the same pattern
 *  apps/web uses. */

/**
 * react-markdown@10 and its unified/remark/micromark cone are ESM-only;
 * ts-jest runs CommonJS, so these packages must be transformed instead
 * of ignored. Alphabetized; most entries are prefix families. If a test
 * dies with `SyntaxError: Cannot use import statement outside a module`
 * naming a path in node_modules, add that package here — the failure is
 * loud and self-locating, never silent.
 */
const ESM_MD_DEPS = [
  'bail',
  'ccount',
  'character-entities',
  'comma-separated-tokens',
  'decode-named-character-reference',
  'devlop',
  'escape-string-regexp',
  'estree-util-is-identifier-name',
  'hast-util-',
  'hastscript',
  'html-url-attributes',
  'inline-style-parser',
  'is-plain-obj',
  'longest-streak',
  'markdown-table',
  'mdast-util-',
  'micromark',
  'property-information',
  'react-markdown',
  'rehype-',
  'remark-',
  'space-separated-tokens',
  'style-to-js',
  'style-to-object',
  'trim-lines',
  'trough',
  'unified',
  'unist-util-',
  'vfile',
  'zwitch',
];

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  // Before the framework, not after: `@tanstack/router-core` reads
  // `TextEncoder` while its module body evaluates, so a missing global
  // breaks the import rather than a test body.
  setupFiles: ['<rootDir>/../test/jsdom-globals.cjs'],
  // Note the asymmetry, inherited from apps/web: `*.spec.ts` and
  // `*.test.tsx` are collected; `*.test.ts` and `*.spec.tsx` are NOT.
  testRegex: '.*\\.(spec\\.ts|test\\.tsx)$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // Vite resolves these; ts-jest does not. Assets imported for their URL
    // (the logo lockup) resolve to a stub string — the components under
    // test care that an `<img src>` exists, not what it points at.
    '\\.(css|woff2?)$': '<rootDir>/../test/style-stub.cjs',
    '\\.(svg|png)$': '<rootDir>/../test/asset-stub.cjs',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.spec.json' }],
    // ESM JS from the allowlisted markdown cone, downleveled to CJS by
    // ts-jest (`allowJs` in tsconfig.spec.json). Scoped to node_modules
    // so app sources and the shared package's dist (realpathed OUTSIDE
    // node_modules by pnpm) keep their current handling. Double
    // backslash before `.` is load-bearing: in a JS string '\.'
    // collapses to '.', which as a regex matches any character.
    '[\\\\/]node_modules[\\\\/].+\\.m?js$': [
      'ts-jest',
      { tsconfig: '<rootDir>/../tsconfig.spec.json', diagnostics: false },
    ],
  },
  // pnpm realpaths packages into node_modules/.pnpm/<pkg>@<v>/node_modules/
  // /<pkg>/ — the FIRST `/node_modules/` segment is always `.pnpm`, so it
  // heads the allowlist and the real decision happens at the second,
  // where the package name appears.
  transformIgnorePatterns: [
    `/node_modules/(?!\\.pnpm|${ESM_MD_DEPS.join('|')})`,
  ],
};
