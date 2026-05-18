import type { CSSProperties, ReactNode } from 'react';

export type TagTone =
  | 'default'
  | 'accent'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'info'
  | 'outline';

const tones: Record<TagTone, { fg: string; bg: string; bd: string }> = {
  default: { fg: 'var(--muted)', bg: 'var(--panel-2)', bd: 'var(--line)' },
  accent: {
    fg: 'var(--accent)',
    bg: 'var(--accent-soft)',
    bd: 'var(--accent-line)',
  },
  ok: { fg: 'var(--ok)', bg: 'var(--ok-soft)', bd: 'transparent' },
  warn: { fg: 'var(--warn)', bg: 'var(--warn-soft)', bd: 'transparent' },
  danger: { fg: 'var(--danger)', bg: 'var(--danger-soft)', bd: 'transparent' },
  info: { fg: 'var(--info)', bg: 'var(--info-soft)', bd: 'transparent' },
  outline: { fg: 'var(--muted)', bg: 'transparent', bd: 'var(--line-2)' },
};

export function Tag({
  children,
  tone = 'default',
  mono = true,
  style,
}: {
  children: ReactNode;
  tone?: TagTone;
  mono?: boolean;
  style?: CSSProperties;
}) {
  const t = tones[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 18,
        padding: '0 6px',
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.bd}`,
        borderRadius: 3,
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: 10.5,
        letterSpacing: mono ? 0.1 : 0,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
