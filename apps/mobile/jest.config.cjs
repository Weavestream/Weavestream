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
