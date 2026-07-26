/** Mirrors apps/web's setup: Jest 30 + ts-jest, no vitest anywhere in
 *  this monorepo. Default environment is node; component/auth specs opt
 *  into jsdom with a `@jest-environment jsdom` docblock, the same pattern
 *  apps/web uses. */
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
  },
};
