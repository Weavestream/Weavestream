'use client';

import { ProfileMenu } from './profile-menu';
import { useShellScope } from './shell-scope-context';
import { SidebarToolbar } from './sidebar-toolbar';

/**
 * Global action cluster rendered by `TopBar` on every authenticated
 * page. Reads its scope from `useShellScope()` (set by `AdminShell` /
 * `CompanyShell`) so individual pages never need to thread these
 * props through `PageHeader`. Returns `null` when no scope is active
 * (login / setup / error fallbacks) so the breadcrumb row stays bare.
 *
 * Layout: the scope-aware shortcuts (Expirations, Starred, Chat) sit
 * on the left of the cluster, with a thin divider before the avatar
 * to separate "page actions" from "account".
 *
 * Two placements render this, and exactly one is visible at a time:
 * `TopBar` owns the desktop row (`hide-on-mobile`), `MobileShellChrome`
 * owns the phone bar (itself `mobile-only`). See `variant`.
 */
export function TopBarActions({
  variant = 'desktop',
}: {
  /**
   * `desktop` — the `TopBar` placement; hides itself below 768px.
   * `mobile` — the `MobileShellChrome` placement; always painted (its
   * host bar already carries `mobile-only`) and drops the AI chat
   * toggle, since `ChatPanel` is `hide-on-mobile` and the toggle would
   * open a panel the viewport never shows.
   */
  variant?: 'desktop' | 'mobile';
} = {}) {
  const scope = useShellScope();
  if (!scope) return null;

  const isMobile = variant === 'mobile';
  const showChat = scope.showChat && !isMobile;

  // Skip the divider when no scope-aware shortcuts are visible (e.g.
  // client portal shells where Expirations/Starred/Chat are all
  // hidden) — a vertical rule floating next to a lone avatar reads as
  // a visual glitch.
  const hasToolbarShortcuts =
    scope.showExpirations || scope.showStarred || showChat;

  return (
    <div
      className={isMobile ? undefined : 'hide-on-mobile'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <SidebarToolbar
        companyId={scope.companyId}
        showStarred={scope.showStarred}
        showExpirations={scope.showExpirations}
        showChat={showChat}
        variant="topbar"
      />
      {hasToolbarShortcuts && (
        <span
          aria-hidden
          style={{
            width: 1,
            height: 18,
            background: 'var(--line)',
            margin: '0 4px',
          }}
        />
      )}
      <ProfileMenu me={scope.me} />
    </div>
  );
}
