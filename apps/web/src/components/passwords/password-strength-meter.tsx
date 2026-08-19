'use client';

import type { CSSProperties, ReactNode } from 'react';
import {
  PASSWORD_STRENGTH_LABELS,
  PASSWORD_STRENGTH_TONES,
  type PasswordStrengthTone,
} from '@weavestream/shared';

const LABELS = PASSWORD_STRENGTH_LABELS;
// The shared tones are semantic names; this is the desktop mapping to
// CSS. `--warn` / `--ok`, not `--warning` / `--success`: the latter two
// are defined nowhere in the token set, so every score of 2+ used to
// paint its hardcoded fallback identically in both themes while score
// 0–1 (on the real `--danger` token) shifted correctly — an
// inconsistency within a single row of bars.
const TONE_TO_CSS: Record<PasswordStrengthTone, string> = {
  danger: 'var(--danger)',
  warn: 'var(--warn)',
  ok: 'var(--ok)',
};
const TONES = PASSWORD_STRENGTH_TONES.map((tone) => TONE_TO_CSS[tone]);

/**
 * Compact 0..4 strength bar sourced from zxcvbn (computed server-side
 * on every save). A `null` score renders the bar in a neutral empty
 * state — that's the first-load case before the password has been
 * scored, or when the record predates the strength field entirely.
 */
export function PasswordStrengthMeter({
  score,
  width = '100%',
  inline = false,
  trailing,
  style,
}: {
  score: number | null;
  width?: string | number;
  inline?: boolean;
  /**
   * Rendered beside the verdict label. The passwords table passes the
   * breach chip here so "very weak" and "seen in 1.6M breaches" read as
   * one judgement rather than two columns.
   *
   * Passing it also left-aligns the stacked label, which is only right
   * for a label that has something to sit next to — every other call
   * site keeps the trailing alignment it has today.
   */
  trailing?: ReactNode;
  style?: CSSProperties;
}) {
  const s = score ?? -1;
  // A scored password colours its own verdict. `--muted` stays for the
  // unscored em dash, where there is no tone to carry.
  const labelColor = TONES[s] ?? 'var(--muted, #8a8a8a)';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: inline ? 'row' : 'column',
        alignItems: inline ? 'center' : 'stretch',
        gap: inline ? 8 : 4,
        width,
        ...style,
      }}
    >
      <div style={{ display: 'flex', gap: 4, flex: inline ? 1 : undefined }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              // Unfilled segments are a 4px track, not a hairline, so they
              // take `--line-3` — the same call the TOTP countdown ring
              // makes. Previously `var(--border, #e5e7eb)`: `--border` is
              // defined nowhere, so the fallback painted a light grey over
              // the dark theme too.
              background:
                i <= s
                  ? TONES[s] ?? 'var(--muted, #8a8a8a)'
                  : 'var(--line-3)',
              transition: 'background 120ms ease',
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: labelColor,
          justifyContent:
            inline || trailing ? 'flex-start' : 'flex-end',
          whiteSpace: 'nowrap',
        }}
      >
        <span>{score === null ? '—' : LABELS[s]}</span>
        {trailing}
      </div>
    </div>
  );
}
