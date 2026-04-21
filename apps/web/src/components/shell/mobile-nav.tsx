'use client';

import { useState, type ReactNode } from 'react';
import { AppLogo, Icon, Sheet } from '../ui';

/**
 * Phase 9c mobile chrome. Renders a compact sticky top bar with a
 * hamburger trigger and workspace wordmark on viewports below
 * Tailwind's `md` breakpoint, and hides itself on desktop so the
 * traditional fixed-sidebar shell is untouched.
 *
 * The `sidebar` prop is a ready-to-render ReactNode (typically a
 * `<Sidebar variant="drawer" />` built on the server). We close the
 * sheet by listening for any `<a>` click inside the drawer content —
 * simpler than threading an `onNavigate` callback across the server
 * boundary, and correctly catches the handful of `<Link>` elements
 * the sidebar renders (nav items, switcher entries, header logo).
 */
export function MobileShellChrome({
  workspaceName,
  sidebar,
}: {
  workspaceName: string;
  sidebar: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div
        className="mobile-only"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          height: 48,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 12px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg)',
        }}
      >
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setOpen(true)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'var(--panel)',
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          <Icon.menu size={16} />
        </button>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
            flex: 1,
          }}
        >
          <AppLogo variant="mark" size={20} />
          <span
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              letterSpacing: -0.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: 'var(--text)',
            }}
          >
            {workspaceName}
          </span>
        </div>
      </div>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        side="left"
        ariaLabel="Navigation"
      >
        <div
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
          onClickCapture={(e) => {
            // Close after any link click — the user almost certainly
            // means to navigate. We look for the nearest anchor in
            // the click path so clicks on deeply nested children
            // (layout swatches, count badges) still close the sheet.
            const target = e.target as HTMLElement | null;
            if (target && target.closest('a')) {
              setOpen(false);
            }
          }}
        >
          {sidebar}
        </div>
      </Sheet>
    </>
  );
}
