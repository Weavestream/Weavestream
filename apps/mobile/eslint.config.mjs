// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.js', '**/*.mjs'],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // Required when several apps' flat configs load in one process
        // (`pnpm -r lint`) — without it, the wrong tsconfig gets picked up.
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // CLAUDE.md: mobile is a separate app, not a responsive skin.
              // `DataTable`/`DataColumn` are a desktop standard, the icon set
              // is drawn for a 16px viewport, and the radius scale is 3–8px
              // against mobile's 9–30px. Sharing components would drag both
              // toward a compromise neither wants. Share logic via
              // `@weavestream/shared` instead.
              //
              // `no-restricted-imports` matches the literal specifier, not
              // the resolved path, so the depth of `../` matters. An
              // earlier version listed `../../web/**` and was trivially
              // bypassed from a nested file with `../../../web/**`. The
              // leading `**/` makes the number of hops irrelevant.
              group: ['**/apps/web/**', '**/web/src/**', '**/../web/**'],
              message:
                'Do not import from apps/web. Promote shared logic into packages/shared instead (CLAUDE.md).',
            },
          ],
        },
      ],

      // Mirrors the ban in apps/web: these hydration-mismatch across
      // timezones and ICU versions. Use the formatters in
      // @weavestream/shared, which take an explicit time zone.
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "CallExpression[callee.property.name=/^(toLocaleString|toLocaleDateString|toLocaleTimeString)$/]",
          message:
            'Do not format dates with toLocale* — use formatDateTime/formatDate/formatCalendarDate/formatRelative from @weavestream/shared with an explicit time zone.',
        },
      ],
    },
  },
);
