import type { CSSProperties, ReactNode } from 'react';

export function Panel({
  title,
  actions,
  children,
  style,
  bodyStyle,
  noPad,
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  /**
   * Extra styles for the inner content wrapper. Useful when a panel
   * needs to participate in its parent's flex sizing (e.g. a dashboard
   * card that scrolls internally so neighbouring panels can stay at
   * equal heights).
   */
  bodyStyle?: CSSProperties;
  noPad?: boolean;
  flush?: boolean;
}) {
  return (
    <section
      style={{
        background: flush ? 'transparent' : 'var(--panel)',
        border: flush ? 'none' : '1px solid var(--line)',
        borderRadius: flush ? 0 : 6,
        ...style,
      }}
    >
      {title && (
        <header
          style={{
            minHeight: 34,
            padding: '0 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            borderBottom: flush ? 'none' : '1px solid var(--line)',
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              flex: 1,
            }}
          >
            {title}
          </div>
          {actions}
        </header>
      )}
      <div style={{ padding: noPad ? 0 : 12, ...bodyStyle }}>{children}</div>
    </section>
  );
}
