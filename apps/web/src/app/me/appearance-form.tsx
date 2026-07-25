'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  uiAccentValues,
  uiThemeValues,
  type UiAccent,
  type UiTheme,
  type UserUiPreferences,
} from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { Btn, Icon, Toggle, useToast } from '../../components/ui';

/**
 * Phase 9b.1 — "Appearance" panel on /me. Lets the user pick theme and
 * accent with a live preview (mutates `data-theme`/`data-accent` on
 * `<html>` without saving), then commits via `PATCH /me/preferences`.
 *
 * Live preview pattern mirrors
 * `apps/web/src/app/admin/(global)/settings/settings-form.tsx` — dirty
 * state is computed from initial + current and the Reset button reverts
 * to the server-known baseline (including the DOM).
 */
export function AppearanceForm({ initial }: { initial: UserUiPreferences }) {
  const router = useRouter();
  const toast = useToast();
  const [theme, setTheme] = useState<UiTheme>(initial.uiTheme);
  const [accent, setAccent] = useState<UiAccent>(initial.uiAccent);
  const [showCounts, setShowCounts] = useState(initial.showItemCounts);
  const [pending, setPending] = useState(false);
  // Track the live-preview effect so unmount / reset restores the DOM
  // even if the user navigates away without saving.
  const restoreRef = useRef<{ theme: string | null; accent: string | null } | null>(
    null,
  );

  useEffect(() => {
    if (restoreRef.current === null) {
      restoreRef.current = {
        theme: document.documentElement.dataset.theme ?? null,
        accent: document.documentElement.dataset.accent ?? null,
      };
    }
    return () => {
      // On unmount, snap back to what the server rendered — the saved
      // copy is whatever the server now knows, so if save succeeded
      // that's already the right value.
      if (restoreRef.current) {
        if (restoreRef.current.theme !== null) {
          document.documentElement.dataset.theme = restoreRef.current.theme;
        }
        if (restoreRef.current.accent !== null) {
          document.documentElement.dataset.accent = restoreRef.current.accent;
        }
      }
    };
  }, []);

  // Apply the picker's current selection to the document for an
  // immediate preview. For `system` we resolve to the OS preference
  // at this moment — matches what the root-layout inline script does.
  useEffect(() => {
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : theme;
    document.documentElement.dataset.theme = resolved;
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  const dirty =
    theme !== initial.uiTheme ||
    accent !== initial.uiAccent ||
    showCounts !== initial.showItemCounts;

  async function save() {
    setPending(true);
    const res = await apiFetch<{ preferences: UserUiPreferences }>(
      '/me/preferences',
      {
        method: 'PATCH',
        body: JSON.stringify({
          uiTheme: theme,
          uiAccent: accent,
          showItemCounts: showCounts,
        }),
      },
    );
    setPending(false);
    if (!res.ok) {
      toast.push('Could not save appearance.', 'danger');
      return;
    }
    // The server just wrote the ws_ui cookie, so the next SSR render
    // will pick it up. `router.refresh()` re-runs the layout without
    // a client-side navigation; the new values become the baseline.
    restoreRef.current = {
      theme: document.documentElement.dataset.theme ?? null,
      accent: document.documentElement.dataset.accent ?? null,
    };
    toast.push('Appearance saved.', 'ok');
    router.refresh();
  }

  function reset() {
    setTheme(initial.uiTheme);
    setAccent(initial.uiAccent);
    setShowCounts(initial.showItemCounts);
  }

  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <FormRow
        label="Theme"
        help="System follows your operating system's light/dark setting."
      >
        <div
          role="radiogroup"
          aria-label="Theme"
          style={{
            display: 'inline-flex',
            padding: 3,
            gap: 2,
            background: 'var(--panel-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 8,
          }}
        >
          {uiThemeValues.map((value) => {
            const active = value === theme;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(value)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 6,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: active ? 'var(--text)' : 'var(--muted)',
                  background: active ? 'var(--elev)' : 'transparent',
                  border: '1px solid',
                  borderColor: active ? 'var(--line-3)' : 'transparent',
                  transition:
                    'background 120ms ease, color 120ms ease, border-color 120ms ease',
                }}
              >
                <ThemeGlyph value={value} />
                <span style={{ textTransform: 'capitalize' }}>{value}</span>
              </button>
            );
          })}
        </div>
      </FormRow>

      <FormRow
        label="Accent"
        help="Used for buttons, links, focused controls, and highlights."
      >
        <div
          role="radiogroup"
          aria-label="Accent color"
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}
        >
          {uiAccentValues.map((value) => (
            <AccentSwatch
              key={value}
              value={value}
              selected={value === accent}
              onSelect={() => setAccent(value)}
            />
          ))}
        </div>
      </FormRow>

      <FormRow label="Density">
        <div style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
          <Toggle
            label="Show item counts in the sidebar"
            help="Totals beside each nav entry. Warning badges — expiring domains, stale passwords, subnet conflicts — always show."
            checked={showCounts}
            onChange={setShowCounts}
          />
        </div>
      </FormRow>

      <div
        style={{
          display: 'flex',
          gap: 10,
          justifyContent: 'flex-end',
          borderTop: '1px solid var(--line)',
          paddingTop: 16,
        }}
      >
        <Btn kind="ghost" onClick={reset} disabled={!dirty || pending}>
          Reset
        </Btn>
        <Btn kind="primary" onClick={save} loading={pending} disabled={!dirty}>
          Save appearance
        </Btn>
      </div>
    </div>
  );
}

function FormRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gap: 2 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--muted)',
            letterSpacing: 0.6,
            textTransform: 'uppercase',
          }}
        >
          {label}
        </span>
        {help ? (
          <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>{help}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function ThemeGlyph({ value }: { value: UiTheme }) {
  if (value === 'light') return <Icon.sun size={13} />;
  if (value === 'dark') return <Icon.moon size={13} />;
  // `system` = half-moon; the Icon set doesn't ship a dedicated glyph
  // so we render a two-tone circle inline. Kept small so it visually
  // matches the sun/moon width.
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 13,
        height: 13,
        borderRadius: '50%',
        background:
          'linear-gradient(90deg, currentColor 0 50%, transparent 50% 100%)',
        border: '1.25px solid currentColor',
      }}
    />
  );
}

function AccentSwatch({
  value,
  selected,
  onSelect,
}: {
  value: UiAccent;
  selected: boolean;
  onSelect: () => void;
}) {
  // Trick: render the swatch with `data-accent={value}` on a wrapper so
  // it reads `var(--accent)` from that selector — guarantees the
  // swatch shows the *same* color the rest of the app will use under
  // the current theme, without hard-coding hex values here.
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={value}
      onClick={onSelect}
      data-accent={value}
      style={{
        width: 36,
        height: 36,
        borderRadius: '50%',
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--accent)',
        border: selected ? '2px solid var(--text)' : '2px solid var(--line-2)',
        boxShadow: selected
          ? '0 0 0 3px var(--bg), 0 0 0 4px var(--accent-line)'
          : 'none',
        transition: 'box-shadow 160ms ease, border-color 120ms ease',
      }}
    >
      {selected ? (
        <Icon.check
          size={14}
          // var(--accent-ink) is the palette's "on-accent" color so
          // the check is legible on any swatch without a manual map.
          style={{ color: 'var(--accent-ink)' }}
        />
      ) : null}
    </button>
  );
}
