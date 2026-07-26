/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],

  // Mobile pins light for v1 (see index.html). The selector is declared
  // anyway so that consuming the shared color vars makes adding dark
  // later close to free.
  darkMode: ['selector', '[data-theme="dark"]'],

  theme: {
    extend: {
      // Every color is var-backed so the user's accent preference and any
      // future palette change carry over. Never write a literal hex in a
      // component — see src/styles/tokens.css.
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        panel: 'var(--panel)',
        elev: 'var(--elev)',
        line: 'var(--line)',
        'line-2': 'var(--line-2)',
        'line-3': 'var(--line-3)',
        text: 'var(--text)',
        'text-2': 'var(--text-2)',
        muted: 'var(--muted)',
        dim: 'var(--dim)',
        faint: 'var(--faint)',
        accent: 'var(--accent)',
        'accent-ink': 'var(--accent-ink)',
        'accent-soft': 'var(--accent-soft)',
        'accent-line': 'var(--accent-line)',
        warn: 'var(--warn)',
        danger: 'var(--danger)',
        ok: 'var(--ok)',
        info: 'var(--info)',
      },

      // Mobile's own scale — NOT desktop's 3/5/8px.
      borderRadius: {
        tile: 'var(--r-tile)',
        seg: 'var(--r-seg)',
        chip: 'var(--r-chip)',
        btn: 'var(--r-btn)',
        pill: 'var(--r-pill)',
        field: 'var(--r-field)',
        card: 'var(--r-card)',
        group: 'var(--r-group)',
        ask: 'var(--r-ask)',
        sheet: 'var(--r-sheet)',
      },

      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },

      fontSize: {
        'screen-title': ['var(--fs-screen-title)', { letterSpacing: '-0.025em' }],
        'sheet-title': ['var(--fs-sheet-title)', { letterSpacing: '-0.02em' }],
        'org-name': ['var(--fs-org-name)', { letterSpacing: '-0.015em' }],
        'card-title': ['var(--fs-card-title)', { letterSpacing: '-0.01em' }],
        body: 'var(--fs-body)',
        meta: 'var(--fs-meta)',
        section: ['var(--fs-section)', { letterSpacing: '0.1em' }],
        tab: 'var(--fs-tab)',
      },

      spacing: {
        // The handoff's scale. `tap` is the 44px floor that every
        // interactive element must clear.
        tap: 'var(--tap-min)',
        control: 'var(--control-h)',
        'card-min': 'var(--card-min-h)',
        'row-min': 'var(--row-min-h)',
        'group-row': 'var(--group-row-h)',
        chip: 'var(--chip-h)',
        ask: 'var(--ask-size)',
        // Safe areas — required on anything anchored to a screen edge
        // (tab bar, bottom sheet, the Ask composer).
        'safe-t': 'env(safe-area-inset-top)',
        'safe-b': 'env(safe-area-inset-bottom)',
        'safe-l': 'env(safe-area-inset-left)',
        'safe-r': 'env(safe-area-inset-right)',
      },

      boxShadow: {
        ask: 'var(--shadow-ask)',
        seg: 'var(--shadow-seg)',
      },
    },
  },

  plugins: [],
};
