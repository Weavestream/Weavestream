'use client';

import { ThemeToggle } from '../ui/theme-toggle';
import { LogoutButton } from './logout-button';

/**
 * Phase 9b.1 — cluster rendered in the sidebar footer. Pairs the quick
 * theme flip with the existing logout button so authenticated shells
 * can drop a single `<SidebarActions />` instead of re-wiring each
 * footer.
 */
export function SidebarActions() {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <ThemeToggle size={22} />
      <LogoutButton />
    </div>
  );
}
