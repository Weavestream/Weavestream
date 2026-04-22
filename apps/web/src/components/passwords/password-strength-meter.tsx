'use client';

import type { CSSProperties } from 'react';

const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
const TONES = [
  'var(--danger, #dc2626)',
  'var(--danger, #dc2626)',
  'var(--warning, #d97706)',
  'var(--success, #16a34a)',
  'var(--success, #16a34a)',
];

/**
 * Compact 0..4 strength bar sourced from zxcvbn (computed server-side
 * on every save). A `null` score renders the bar in a neutral empty
 * state — that's the first-load case before the password has been
 * scored, or when the record predates the strength field entirely.
 */
export function PasswordStrengthMeter({
  score,
  width = '100%',
  style,
}: {
  score: number | null;
  width?: string | number;
  style?: CSSProperties;
}) {
  const s = score ?? -1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width, ...style }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background:
                i <= s
                  ? TONES[s] ?? 'var(--muted, #6b7280)'
                  : 'var(--border, #e5e7eb)',
              transition: 'background 120ms ease',
            }}
          />
        ))}
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--muted, #6b7280)',
          textAlign: 'right',
        }}
      >
        {score === null ? '—' : LABELS[s]}
      </div>
    </div>
  );
}
