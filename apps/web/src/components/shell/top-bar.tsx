'use client';

import type { ReactNode } from 'react';
import { Fragment } from 'react';
import { CompanyStickyNote } from './company-sticky-note';
import { useStickyNote } from './sticky-note-context';

export type Crumb = {
  label: ReactNode;
  href?: string;
  mono?: boolean;
};

export function TopBar({
  crumbs = [],
  right,
  sub,
  subClassName,
}: {
  crumbs?: Crumb[];
  right?: ReactNode;
  sub?: ReactNode;
  /**
   * Optional class applied to the sub-row container. `PageHeader`
   * passes `page-header-sub` so the title/actions row stacks on
   * mobile (see `globals.css`).
   */
  subClassName?: string;
}) {
  // The per-company sticky note (when set) renders as the first row
  // INSIDE this sticky container, not as a separate sticky sibling —
  // two siblings with `top: 0` would overlap on scroll and the
  // breadcrumbs would slide behind the banner. Outside a CompanyShell
  // the context defaults to null and nothing renders.
  const stickyNote = useStickyNote();
  return (
    <div
      style={{
        borderBottom: '1px solid var(--line)',
        background: 'var(--bg)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}
    >
      {stickyNote ? (
        <CompanyStickyNote
          text={stickyNote.text}
          severity={stickyNote.severity}
        />
      ) : null}
      <div
        style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          gap: 10,
        }}
      >
        <div
          className="no-scrollbar"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: 1,
            minWidth: 0,
            // Long breadcrumb trails scroll horizontally on phones
            // instead of wrapping into a second row and pushing the
            // page-header title down. `whiteSpace: nowrap` forces the
            // inline children onto one line; overflow: auto keeps
            // that line scrubbable.
            whiteSpace: 'nowrap',
            overflowX: 'auto',
          }}
        >
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            // Mono and sans glyphs have different intrinsic metrics, so
            // relying on flex `alignItems: center` leaves the mono crumb
            // visibly higher than its siblings. Pinning a shared
            // `lineHeight: 1` + `display: inline-flex` flattens each
            // label to exactly its font box so baselines line up.
            const node = (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: 12.5,
                  lineHeight: 1,
                  color: last ? 'var(--text)' : 'var(--muted)',
                  fontWeight: last ? 500 : 400,
                  fontFamily: c.mono ? 'var(--font-mono)' : 'var(--font-sans)',
                }}
              >
                {c.label}
              </span>
            );
            return (
              <Fragment key={i}>
                {i > 0 && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      color: 'var(--faint)',
                      fontSize: 12.5,
                      lineHeight: 1,
                    }}
                  >
                    /
                  </span>
                )}
                {c.href && !last ? (
                  <a
                    href={c.href}
                    style={{ display: 'inline-flex', alignItems: 'center' }}
                  >
                    {node}
                  </a>
                ) : (
                  node
                )}
              </Fragment>
            );
          })}
        </div>
        {right && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {right}
          </div>
        )}
      </div>
      {sub && (
        <div
          className={subClassName}
          style={{
            padding: '0 20px 10px',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
