'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { UiTheme } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import {
  applyDomTheme,
  useDomTheme,
  useThemeHydrated,
} from '../../lib/hooks/use-dom-theme';
import { Icon } from '../ui';
import type { ShellScopeMe } from './shell-scope-context';

/**
 * Avatar button rendered in the global top-bar action cluster.
 * Clicking opens a small popover with the user's identity, a link to
 * `/me`, a quick theme flip, and Sign-out — the single home for
 * account-scoped controls that used to be split between the sidebar
 * footer (theme + sign-out) and an "Account" nav section (Profile).
 *
 * The popover is positioned via `getBoundingClientRect` (same pattern
 * as `StarredQuickAccessTrigger`) so it floats below the avatar and
 * stays anchored when the viewport scrolls or resizes.
 */
export function ProfileMenu({ me }: { me: ShellScopeMe }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 8;
    const viewportPad = 12;
    const width = Math.min(260, window.innerWidth - viewportPad * 2);
    const left = Math.max(
      viewportPad,
      Math.min(rect.right - width, window.innerWidth - width - viewportPad),
    );
    setPosition({ left, top: rect.bottom + gap, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, updatePosition]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open account menu"
        title={me.name}
        onClick={() => {
          updatePosition();
          setOpen((v) => !v);
        }}
        className="sidebar-toolbar-icon"
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          border: open ? '1px solid var(--line-2)' : '1px solid var(--line)',
          background:
            'linear-gradient(135deg, var(--line-3), var(--panel-2))',
          color: 'var(--text-2)',
          fontSize: 11,
          fontWeight: 600,
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer',
          letterSpacing: 0.2,
        }}
      >
        {me.initials}
      </button>
      {open && position && (
        <div
          ref={popoverRef}
          role="menu"
          aria-label="Account menu"
          style={{
            position: 'fixed',
            left: position.left,
            top: position.top,
            width: position.width,
            maxWidth: 'calc(100vw - 24px)',
            zIndex: 70,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-2)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ProfileHeader me={me} />
          <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <MenuLink
              href="/me"
              icon="person"
              label="Profile"
              onSelect={() => setOpen(false)}
            />
            <AppearanceRow />
          </div>
          <div style={{ borderTop: '1px solid var(--line)', padding: 6 }}>
            <SignOutRow onSignedOut={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

function ProfileHeader({ me }: { me: ShellScopeMe }) {
  return (
    <div
      style={{
        padding: '12px 12px 10px',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
      }}
    >
      <div
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background:
            'linear-gradient(135deg, var(--line-3), var(--panel-2))',
          border: '1px solid var(--line-2)',
          fontSize: 12,
          fontWeight: 600,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text-2)',
          flexShrink: 0,
        }}
      >
        {me.initials}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {me.name}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {me.email}
        </div>
      </div>
    </div>
  );
}

const MENU_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '8px 10px',
  borderRadius: 6,
  fontSize: 13,
  color: 'var(--text)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none',
  textAlign: 'left',
};

function MenuLink({
  href,
  icon,
  label,
  onSelect,
}: {
  href: string;
  icon: 'person';
  label: string;
  onSelect: () => void;
}) {
  const IconCmp = Icon[icon];
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onSelect}
      prefetch={false}
      className="sidebar-switcher-entry"
      style={MENU_ROW_STYLE}
    >
      <IconCmp size={14} stroke={1.5} style={{ color: 'var(--muted)' }} />
      <span style={{ flex: 1 }}>{label}</span>
    </Link>
  );
}

/**
 * Theme row. The unauthenticated `ThemeToggle` square button still
 * lives on the login / setup pages via `AuthShell`; this row is the
 * authenticated-shell equivalent.
 *
 * Mirrors the same persistence flow: optimistic DOM flip first, then
 * `PATCH /me/preferences` (with a `POST /public/ui-prefs` fallback for
 * the 401 edge-case mid-session-expiry).
 *
 * The displayed value comes from `useDomTheme()` rather than a local
 * mount-time sample: this menu is mounted twice at once (desktop
 * `TopBar` + `MobileShellChrome`), so a copy taken when the popover
 * opened would go stale the moment the other instance — or the `/me`
 * appearance form, or an OS light/dark flip — changed the theme.
 */
function AppearanceRow() {
  const theme = useDomTheme();
  const mounted = useThemeHydrated();

  async function flip() {
    const next: UiTheme = theme === 'dark' ? 'light' : 'dark';
    applyDomTheme(next);
    const res = await apiFetch('/me/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ uiTheme: next }),
    });
    if (!res.ok && res.status === 401) {
      await apiFetch('/public/ui-prefs', {
        method: 'POST',
        body: JSON.stringify({ uiTheme: next }),
      });
    }
  }

  const Glyph = theme === 'dark' ? Icon.sun : Icon.moon;
  const nextLabel = theme === 'dark' ? 'Light mode' : 'Dark mode';

  return (
    <button
      type="button"
      role="menuitem"
      onClick={flip}
      aria-label={`Switch to ${nextLabel.toLowerCase()}`}
      className="sidebar-switcher-entry"
      style={MENU_ROW_STYLE}
      suppressHydrationWarning
    >
      <Glyph size={14} stroke={1.5} style={{ color: 'var(--muted)' }} />
      <span style={{ flex: 1 }}>Appearance</span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: 'var(--dim)',
          opacity: mounted ? 1 : 0.6,
        }}
      >
        {theme === 'dark' ? 'Dark' : 'Light'}
      </span>
    </button>
  );
}

function SignOutRow({ onSignedOut }: { onSignedOut: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await apiFetch('/auth/logout', { method: 'POST' });
        onSignedOut();
        router.push('/login');
        router.refresh();
      }}
      className="sidebar-switcher-entry"
      style={{
        ...MENU_ROW_STYLE,
        color: 'var(--danger)',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Icon.logout
        size={14}
        stroke={1.5}
        style={{ color: 'var(--danger)' }}
      />
      <span style={{ flex: 1 }}>{busy ? 'Signing out…' : 'Sign out'}</span>
    </button>
  );
}
