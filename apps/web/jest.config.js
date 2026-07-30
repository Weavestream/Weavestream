/**
 * react-markdown@10 and its unified/remark/micromark cone are ESM-only;
 * ts-jest runs CommonJS, so these packages must be transformed instead
 * of ignored. Alphabetized; most entries are prefix families. If a test
 * dies with `SyntaxError: Cannot use import statement outside a module`
 * naming a path in node_modules, add that package here — the failure is
 * loud and self-locating, never silent.
 *
 * Kept byte-identical to `apps/mobile/jest.config.cjs`'s copy (which
 * inherited the pattern from here). Both apps render the same markdown
 * stack; a list that drifts produces a suite that passes on one surface
 * and cannot even import on the other. Its absence here is why
 * `markdown-view.tsx` had no test until the diagram work needed one.
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

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.(spec\\.ts|test\\.tsx)$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
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
