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
 */
export function TopBarActions() {
  const scope = useShellScope();
  if (!scope) return null;

  // Skip the divider when no scope-aware shortcuts are visible (e.g.
  // client portal shells where Expirations/Starred/Chat are all
  // hidden) — a vertical rule floating next to a lone avatar reads as
  // a visual glitch.
  const hasToolbarShortcuts =
    scope.showExpirations || scope.showStarred || scope.showChat;

  return (
    <div
      className="hide-on-mobile"
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
        showChat={scope.showChat}
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
