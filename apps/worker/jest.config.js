// Specs load API sources that import `jose`, which is ESM-only. Jest can
// require() it only when Node exposes the vm module API, so `pnpm test` sets
// NODE_OPTIONS=--experimental-vm-modules (same as apps/api/jest.config.js).
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
};
