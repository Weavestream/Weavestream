// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ESLint 9 flat config for the NestJS worker.
 *
 * Rules are intentionally permissive for the v1.0.0 release — our
 * `typecheck` job is the strict gate. Post-1.0 we'll tighten these
 * (no-explicit-any, floating-promises, consistent-type-imports) as
 * we clean up.
 */
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.js'],
  },
  ...tseslint.configs.recommended,
  {
    // Required once several apps' configs load in one ESLint process (the
    // IDE server): the parser refuses to infer a root when multiple
    // candidates exist. https://tseslint.com/parser-tsconfigrootdir
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // The worker may use only the API's package exports
      // (`@weavestream/api/<entry>`, built from `apps/api/src/public/`).
      // A relative path into API source compiles a copy of the API into
      // this app's dist, where it resolves packages against the worker's
      // node_modules instead of the API's own.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: 'api/src/',
              message:
                'Import from @weavestream/api/<entry> instead. If the worker needs something new, export it from apps/api/src/public/ and apps/api/package.json "exports".',
            },
          ],
        },
      ],
    },
  },
);
