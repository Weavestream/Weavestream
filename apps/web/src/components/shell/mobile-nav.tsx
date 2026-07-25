'use client';

import { useState, type ReactNode } from 'react';
import { AppLogo, Icon, Sheet } from '../ui';
import { useSearchPalette } from '../search/search-palette-provider';
import { useShellScope } from './shell-scope-context';
import { ToolbarIconButton } from './sidebar-toolbar';
import { TopBarActions } from './top-bar-actions';

/**
 * Phase 9c mobile chrome. Renders a compact sticky top bar with a
 * hamburger trigger and workspace wordmark on viewports below
 * Tailwind's `md` breakpoint, and hides itself on desktop so the
 * traditional fixed-sidebar shell is untouched.
 *
 * This bar also carries the global chrome that `TopBar` hides below
 * 768px — the search trigger and the Expirations / Starred / account
 * cluster. `TopBar` renders those for desktop only (`hide-on-mobile`),
 * and search no longer lives in the sidebar, so without them here a
 * touch user has no way to reach either: search would be
 * keyboard-shortcut-only, and the account menu (profile, theme, sign
 * out) unreachable entirely.
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
  // Gated on the shell scope rather than on the palette hook, matching
  // `TopBar`: `useSearchPalette()` returns a no-op context outside a
  // provider, so it can't tell us whether a palette actually exists.
  // Both shells that mount this chrome provide the two together.
  const palette = useSearchPalette();
  const shellScope = useShellScope();

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
            flexShrink: 0,
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
        {shellScope && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              // The workspace name owns the slack and ellipsises; the
              // controls keep their full width on the narrowest phone.
              flexShrink: 0,
            }}
          >
            <ToolbarIconButton
              icon="search"
              label="Open search"
              active={palette.isOpen}
              onClick={palette.open}
              variant="topbar"
            />
            <TopBarActions variant="mobile" />
          </div>
        )}
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
