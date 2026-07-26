// @ts-check
import tseslint from 'typescript-eslint';

/**
 * CLAUDE.md: mobile is a separate app, not a responsive skin.
 * `DataTable`/`DataColumn` are a desktop standard, the icon set is drawn
 * for a 16px viewport, and the radius scale is 3–8px against mobile's
 * 9–30px. Sharing components would drag both toward a compromise neither
 * wants. Share logic via `@weavestream/shared` instead.
 *
 * `no-restricted-imports` matches the literal specifier, not the resolved
 * path, so the depth of `../` matters. An earlier version listed
 * `../../web/**` and was trivially bypassed from a nested file with
 * `../../../web/**`. The leading `**\/` makes the number of hops
 * irrelevant.
 */
const NO_APPS_WEB = {
  group: ['**/apps/web/**', '**/web/src/**', '**/../web/**'],
  message:
    'Do not import from apps/web. Promote shared logic into packages/shared instead (CLAUDE.md).',
};

export default tseslint.config(
  {
    // `.cjs` covers the Jest config, its setup file, and the module
    // stubs — Node CommonJS outside the app's own module graph.
    ignores: ['dist/**', 'node_modules/**', '**/*.js', '**/*.mjs', '**/*.cjs'],
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

      'no-restricted-imports': ['error', { patterns: [NO_APPS_WEB] }],

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
  {
    // Every history entry this app pushes must carry the org it was
    // created under, or browser back can resurrect one client's screen
    // under another client's header. `useScopedNavigate` / `ScopedLink`
    // add that stamp; raw `useNavigate` / `Link` silently do not.
    //
    // Enforced across all of `src` rather than only the screens, so a
    // component added later cannot quietly skip the stamp. Exactly two
    // files are exempt: the router (which owns the pre-scope auth routes)
    // and the wrappers themselves.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/router.tsx', 'src/lib/scoped-nav.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [NO_APPS_WEB],
          paths: [
            {
              name: '@tanstack/react-router',
              importNames: ['useNavigate', 'Link'],
              message:
                'Use useScopedNavigate/ScopedLink from lib/scoped-nav instead — navigations must stamp the current org so back cannot restore a previous org’s screen.',
            },
          ],
        },
      ],
    },
  },
);
