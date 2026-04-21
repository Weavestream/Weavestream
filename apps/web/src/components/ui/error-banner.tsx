import type { ReactNode } from 'react';
import { Icon } from './icon';

export type ErrorBannerTone = 'danger' | 'warn';

/**
 * Phase 9b.2 — inline error strip for partial-failure states where the
 * page can still render the rest of itself (e.g. the company overview
 * when the memberships endpoint 403s but assets and domains load
 * fine). Toasts handle *transient* write failures; this is for the
 * "something here refused to load" case that otherwise disappears
 * into a silent empty table.
 */
export function ErrorBanner({
  title,
  detail,
  tone = 'danger',
  children,
}: {
  title: string;
  detail?: string | null;
  tone?: ErrorBannerTone;
  children?: ReactNode;
}) {
  const colors =
    tone === 'warn'
      ? {
          fg: 'var(--warn)',
          bg: 'var(--warn-soft)',
          bd: 'color-mix(in oklch, var(--warn) 30%, transparent)',
        }
      : {
          fg: 'var(--danger)',
          bg: 'var(--danger-soft)',
          bd: 'color-mix(in oklch, var(--danger) 30%, transparent)',
        };
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 12px',
        background: colors.bg,
        border: `1px solid ${colors.bd}`,
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      <Icon.warn size={14} style={{ color: colors.fg, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: 'var(--text)', fontWeight: 500 }}>{title}</div>
        {detail ? (
          <div
            style={{
              marginTop: 2,
              color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              wordBreak: 'break-word',
            }}
          >
            {detail}
          </div>
        ) : null}
        {children ? <div style={{ marginTop: 6 }}>{children}</div> : null}
      </div>
    </div>
  );
}
