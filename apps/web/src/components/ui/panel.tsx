import type { CSSProperties, ReactNode } from 'react';

export function Panel({
  title,
  actions,
  children,
  style,
  bodyStyle,
  noPad,
  flush,
  fillHeight,
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
  /**
   * Stretch the panel to fill the available height of a flex parent
   * (typically `PageBody`) and constrain the body so its child can
   * scroll internally — i.e. a `DataTable fillHeight` underneath gets
   * its own scroll surface and the page header stays put. Opt-in so
   * stacked-panel pages keep their natural full-page scroll behaviour.
   */
  fillHeight?: boolean;
}) {
  return (
    <section
      style={{
        background: flush ? 'transparent' : 'var(--panel)',
        border: flush ? 'none' : '1px solid var(--line)',
        borderRadius: flush ? 0 : 6,
        ...(fillHeight
          ? {
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
              overflow: 'hidden',
            }
          : null),
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
            flexShrink: 0,
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
      <div
        style={{
          padding: noPad ? 0 : 12,
          ...(fillHeight
            ? {
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              }
            : null),
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </section>
  );
}
