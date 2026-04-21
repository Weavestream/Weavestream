'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useIsMobile } from '../../lib/hooks/use-is-mobile';

/**
 * Guard against XSS via attacker-controlled `rowHref` return values.
 *
 * `DataTable` navigates on row click using the string returned from the
 * caller-provided `rowHref`. If that ever evaluated to something like
 * `javascript:...`, assigning it to `window.location.href` (or handing it
 * to the router) would execute script in the victim's origin.
 *
 * We therefore only accept same-origin, relative paths:
 *   - must start with a single `/`
 *   - must NOT start with `//` (protocol-relative → cross-origin)
 *   - must NOT start with `/\` (some browsers normalize backslashes to `/`,
 *     so `/\\evil.com` can be treated as protocol-relative)
 *
 * Anything else (absolute URLs, `javascript:`, `data:`, `vbscript:`, empty
 * strings, etc.) is rejected and the click is ignored.
 */
function isSafeInternalHref(href: string | undefined): href is string {
  if (typeof href !== 'string' || href.length === 0) return false;
  if (href[0] !== '/') return false;
  if (href[1] === '/' || href[1] === '\\') return false;
  return true;
}

export type DataColumn<T> = {
  id: string;
  header: ReactNode;
  width?: number | string;
  align?: 'left' | 'right';
  mono?: boolean;
  render: (row: T) => ReactNode;
};

/**
 * Small helper for mobile card bodies. Renders a label/value row with
 * the same mono label styling used by admin inspector panels, so each
 * `renderMobileCard` implementation stays consistent without a local
 * layout component. Value can be any ReactNode (chips, relative times,
 * user-picker display, …).
 */
export function MobileCardRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        padding: '3px 0',
        fontSize: 12.5,
        color: 'var(--text-2)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: 'var(--dim)',
          minWidth: 72,
        }}
      >
        {label}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          wordBreak: 'break-word',
        }}
      >
        {children}
      </div>
    </div>
  );
}

const cellBase: CSSProperties = {
  padding: '10px 12px',
  fontSize: 12.5,
  color: 'var(--text-2)',
  borderBottom: '1px solid var(--line)',
  verticalAlign: 'middle',
};

const headCellBase: CSSProperties = {
  ...cellBase,
  textAlign: 'left',
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  background: 'var(--panel)',
  borderBottom: '1px solid var(--line)',
  position: 'sticky',
  top: 0,
  zIndex: 1,
};

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  empty,
  rowHref,
  onRowClick,
  renderMobileCard,
}: {
  columns: DataColumn<T>[];
  rows: T[];
  empty?: ReactNode;
  rowHref?: (row: T) => string;
  // Phase 9a: lets callers open a detail drawer from a click without
  // giving up the pointer-cursor + hover affordance baked in here.
  // Ignored when `rowHref` is also set (links win).
  onRowClick?: (row: T) => void;
  /**
   * Phase 9c: render a per-row card on viewports below Tailwind's
   * `md` breakpoint. When defined, the table body is replaced with a
   * vertical list of cards (one per row) so data-dense tables stay
   * legible on phones. `rowHref`/`onRowClick` still fire from a click
   * on the card wrapper.
   */
  renderMobileCard?: (row: T) => ReactNode;
}) {
  const isMobile = useIsMobile();
  const router = useRouter();
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 32,
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 12.5,
        }}
      >
        {empty ?? 'Nothing here yet.'}
      </div>
    );
  }
  if (isMobile && renderMobileCard) {
    return (
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {rows.map((row) => {
          const rawHref = rowHref?.(row);
          const safeHref = isSafeInternalHref(rawHref) ? rawHref : undefined;
          const clickable = Boolean(safeHref || onRowClick);
          return (
            <li
              key={row.id}
              onClick={(e) => {
                if (!clickable) return;
                if (
                  e.target instanceof HTMLElement &&
                  e.target.closest('a, button, [role="button"]')
                ) {
                  return;
                }
                if (safeHref) {
                  router.push(safeHref);
                } else if (onRowClick) {
                  onRowClick(row);
                }
              }}
              style={{
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: 12,
                background: 'var(--panel)',
                cursor: clickable ? 'pointer' : 'default',
                transition: 'background-color 120ms ease',
              }}
            >
              {renderMobileCard(row)}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
        }}
      >
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.id}
                style={{
                  ...headCellBase,
                  width: c.width,
                  textAlign: c.align ?? 'left',
                }}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rawHref = rowHref?.(row);
            const safeHref = isSafeInternalHref(rawHref) ? rawHref : undefined;
            const clickable = Boolean(safeHref || onRowClick);
            return (
              <tr
                key={row.id}
                style={{
                  cursor: clickable ? 'pointer' : 'default',
                  transition: 'background-color 100ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--panel-2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
                onClick={(e) => {
                  if (!clickable) return;
                  if (
                    e.target instanceof HTMLElement &&
                    e.target.closest('a, button, [role="button"]')
                  ) {
                    return;
                  }
                  if (safeHref) {
                    router.push(safeHref);
                  } else if (onRowClick) {
                    onRowClick(row);
                  }
                }}
              >
                {columns.map((c) => (
                  <td
                    key={c.id}
                    style={{
                      ...cellBase,
                      textAlign: c.align ?? 'left',
                      fontFamily: c.mono ? 'var(--font-mono)' : undefined,
                      width: c.width,
                    }}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
