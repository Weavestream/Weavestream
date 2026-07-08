// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ESLint 9 flat config for the Next.js 16 web app.
 *
 * `next lint` was removed in Next 15+, so we wire up `eslint-config-next`
 * directly as the standard config exports it. The config already brings
 * in `@typescript-eslint` + `react`/`react-hooks`/`jsx-a11y`/`import`
 * plugins, so we only override rule severities here — redeclaring the
 * plugins crashes ESLint with "Cannot redefine plugin" under pnpm.
 *
 * Rules are intentionally permissive for the v1.0.0 release — our
 * `typecheck` job is the strict gate. Post-1.0 we'll tighten these
 * (no-explicit-any, exhaustive-deps, react-hooks/* ) as we clean up.
 */
import next from 'eslint-config-next';

export default [
  {
    ignores: ['.next/**', 'next-env.d.ts', 'public/**', 'node_modules/**'],
  },
  ...next,
  {
    // Required once several apps' configs load in one ESLint process (the
    // IDE server): the parser refuses to infer a root when multiple
    // candidates exist. https://tseslint.com/parser-tsconfigrootdir
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    rules: {
      'react/no-unescaped-entities': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
      'import/no-anonymous-default-export': 'warn',
      'jsx-a11y/role-has-required-aria-props': 'warn',
      // The following are new strict checks shipped by eslint-config-next
      // 16 for React 19. They flag real issues (stale closures, setState
      // in effects, ref mutation) that we plan to fix incrementally.
      // Downgraded to warnings for v1.0.0 so CI isn't blocked on a
      // codebase-wide refactor. Tracked as post-1.0 cleanup.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      // Dates: bare toLocale* mismatches on SSR hydration (server tz/ICU
      // vs the browser's). Use the shared formatters from
      // `@weavestream/shared` with `useTimezone()` (or the `<Formatted*>`
      // components in `lib/timezone-context`). Warn-level to match the
      // v1.0.0 posture; this also flags the not-yet-migrated server
      // components (a correctness backlog, not a hydration bug). The
      // number-format callers are exempted in the override below.
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "CallExpression[callee.property.name=/^(toLocaleString|toLocaleDateString|toLocaleTimeString)$/]",
          message:
            'Do not format dates with toLocaleString/toLocaleDateString/toLocaleTimeString — they hydration-mismatch across timezones and ICU versions. Use formatDateTime/formatDate/formatCalendarDate/formatRelative from @weavestream/shared with useTimezone(), or the <Formatted*> components in lib/timezone-context.',
        },
      ],
    },
  },
  {
    // These call `.toLocaleString()` on NUMBERS (counts/totals) — locale
    // digit grouping, which carries no timezone/ICU hydration risk — so
    // they are exempt from the date-formatting guard above.
    files: [
      '**/components/ui/pagination.tsx',
      '**/components/shell/sidebar.tsx',
      '**/audit/page.tsx',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
