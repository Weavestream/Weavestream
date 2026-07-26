'use client';

import type { CSSProperties } from 'react';
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
  style,
}: {
  score: number | null;
  width?: string | number;
  inline?: boolean;
  style?: CSSProperties;
}) {
  const s = score ?? -1;
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
                  ? TONES[s] ?? 'var(--muted, #6b7280)'
                  : 'var(--line-3)',
              transition: 'background 120ms ease',
            }}
          />
        ))}
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--muted, #6b7280)',
          textAlign: inline ? 'left' : 'right',
          whiteSpace: 'nowrap',
        }}
      >
        {score === null ? '—' : LABELS[s]}
      </div>
    </div>
  );
}
