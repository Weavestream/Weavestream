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
        variant="topbar"
      />
      <span
        aria-hidden
        style={{
          width: 1,
          height: 18,
          background: 'var(--line)',
          margin: '0 4px',
        }}
      />
      <ProfileMenu me={scope.me} />
    </div>
  );
}
