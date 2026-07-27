/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],

  // Theme-aware since Phase 4: the shell arrives stamped with the
  // resolved `data-theme` (see index.html + emit-to-web.mjs) and
  // ui-prefs.ts keeps it in sync at runtime. NOTE the selector misses
  // the system-pref/light-OS pre-hydration frame (`data-theme="dark"`
  // + OS-light, corrected by CSS media blocks) — so `dark:` utilities
  // are for JS-era styling only; anything that must be right on first
  // paint uses the theme-tripled token vars instead.
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
        'panel-2': 'var(--panel-2)',
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
        // Role-tuned accents — see src/styles/tokens.css for why the raw
        // fill value can't serve text or on-tint roles.
        'accent-pressed': 'var(--accent-pressed)',
        'accent-text': 'var(--accent-text)',
        'accent-deep': 'var(--accent-deep)',
        warn: 'var(--warn)',
        'warn-soft': 'var(--warn-soft)',
        danger: 'var(--danger)',
        'danger-soft': 'var(--danger-soft)',
        ok: 'var(--ok)',
        'ok-soft': 'var(--ok-soft)',
        info: 'var(--info)',
        'info-soft': 'var(--info-soft)',
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
        // The handoff's spacing scale is 3/4/6/7/8/10/12/13/14/16/18/22px.
        // Tailwind's 4px-based scale covers all but these four, so they
        // are added as the fractional steps that keep the idiom
        // (`px-4.5` = 18px, the sheet's horizontal padding).
        0.75: '3px',
        1.75: '7px',
        2.25: '9px',
        3.25: '13px',
        4.5: '18px',
        5.5: '22px',

        // `tap` is the 44px floor that every interactive element must clear.
        tap: 'var(--tap-min)',
        control: 'var(--control-h)',
        'card-min': 'var(--card-min-h)',
        'row-min': 'var(--row-min-h)',
        'group-row': 'var(--group-row-h)',
        chip: 'var(--chip-h)',
        ask: 'var(--ask-size)',
        'tab-icon': 'var(--tab-icon)',
        // Safe areas — required on anything anchored to a screen edge
        // (tab bar, bottom sheet, the Ask composer).
        //
        // Prefer `edge-b` over the raw `safe-b` at the bottom: the raw
        // inset is 0 on non-notched devices. See tokens.css.
        'safe-t': 'env(safe-area-inset-top)',
        'safe-b': 'env(safe-area-inset-bottom)',
        'edge-b': 'var(--pad-edge-b)',
        'edge-t': 'var(--pad-edge-t)',
        'safe-l': 'env(safe-area-inset-left)',
        'safe-r': 'env(safe-area-inset-right)',
      },

      boxShadow: {
        ask: 'var(--shadow-ask)',
        seg: 'var(--shadow-seg)',
      },

      maxWidth: {
        // The one shared content column — see tokens.css.
        page: 'var(--page-max-w)',
      },

      zIndex: {
        tabbar: 'var(--z-tabbar)',
        sheet: 'var(--z-sheet)',
        stepup: 'var(--z-stepup)',
        toast: 'var(--z-toast)',
      },
    },
  },

  plugins: [],
};
