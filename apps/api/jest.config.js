const { SourceTextModule } = require('node:vm');

// The upload magic-byte check loads `file-type`, which is ESM-only, through a
// lazy `require()`. Jest can run that only when Node exposes the vm module
// API (`--experimental-vm-modules`); without it Jest drops the `module-sync`
// export condition and the require fails as "Cannot find module 'file-type'".
// `pnpm test` sets the flag. Fail fast so a bare `npx jest` says so instead of
// reporting the real file-type tests as broken.
if (typeof SourceTextModule !== 'function') {
  throw new Error(
    'apps/api tests need Node --experimental-vm-modules. Run `pnpm test` ' +
      '(optionally `pnpm test -- <path>`), or prefix the command with ' +
      'NODE_OPTIONS=--experimental-vm-modules.',
  );
}

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // NodeNext TS imports end in .js; strip so Jest resolves the .ts source.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
};
