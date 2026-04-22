'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from '../ui';

/**
 * Thin icon strip rendered in the sidebar footer, just above the user
 * block. Think "tray" — quick-access, scope-aware shortcuts that
 * don't belong in the main nav but should be a single click away from
 * every page in the shell.
 *
 * Icons are 26×26 tappable targets (meets Apple HIG minimum), spaced
 * so the whole row fits comfortably in the 232px sidebar even with
 * five shortcuts. The active page gets an accent tint to match the
 * main `NavItem` treatment.
 */
export function SidebarToolbar({
  companyId,
}: {
  /**
   * When present, all scoped shortcuts target the company routes
   * (`/admin/companies/:id/...`). Omit for the global admin variant
   * where the same shortcuts resolve to cross-tenant routes.
   */
  companyId?: string;
}) {
  const base = companyId ? `/admin/companies/${companyId}` : '/admin';

  return (
    <>
      <ToolbarIconLink
        href={`${base}/expirations`}
        icon="clock"
        label="Expiring soon"
      />
    </>
  );
}

function ToolbarIconLink({
  href,
  icon,
  label,
  badge,
}: {
  href: string;
  icon: IconName;
  label: string;
  /** Optional red dot for "has items" affordance — rendered when `> 0`. */
  badge?: number;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  const IconCmp = Icon[icon];

  const style: CSSProperties = {
    width: 26,
    height: 26,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 5,
    color: active ? 'var(--text)' : 'var(--muted)',
    background: active ? 'var(--panel-2)' : 'transparent',
    position: 'relative',
    cursor: 'pointer',
  };

  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="sidebar-toolbar-icon"
      style={style}
    >
      <IconCmp size={14} stroke={1.5} />
      {badge !== undefined && badge > 0 && <BadgeDot />}
    </Link>
  );
}

function BadgeDot(): ReactNode {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        top: 4,
        right: 4,
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--warn)',
        boxShadow: '0 0 0 1.5px var(--surface)',
      }}
    />
  );
}
