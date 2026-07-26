/** Mirrors apps/web's setup: Jest 30 + ts-jest, no vitest anywhere in
 *  this monorepo. Default environment is node; component/auth specs opt
 *  into jsdom with a `@jest-environment jsdom` docblock, the same pattern
 *  apps/web uses. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  // Note the asymmetry, inherited from apps/web: `*.spec.ts` and
  // `*.test.tsx` are collected; `*.test.ts` and `*.spec.tsx` are NOT.
  testRegex: '.*\\.(spec\\.ts|test\\.tsx)$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // Vite resolves these; ts-jest does not.
    '\\.(css|woff2?)$': '<rootDir>/../test/style-stub.cjs',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.spec.json' }],
  },
};
