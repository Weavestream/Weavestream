'use client';

import { createContext, useContext, type ReactNode } from 'react';

export type ShellScopeMe = {
  name: string;
  email: string;
  initials: string;
};

export type ShellScopeValue = {
  /**
   * When present, the top-bar action cluster targets company-scoped
   * routes (`/admin/companies/:id/expirations`, etc.). Omit for the
   * global admin variant where the same shortcuts resolve to
   * cross-tenant routes.
   */
  companyId?: string;
  /** Mirrors the server-computed sidebar flag — gates Starred drawer. */
  showStarred: boolean;
  /** Mirrors the server-computed sidebar flag — gates Expirations link. */
  showExpirations: boolean;
  /**
   * Gates the AI chat toggle in the top-bar action cluster. Hidden on
   * client portal shells where the chat panel has no scoped context
   * and isn't useful to end users. The provider/keyboard shortcut
   * still mounts so the panel can be opened manually if needed.
   */
  showChat: boolean;
  /** Avatar + profile-menu copy. Sourced from the authenticated `Me`. */
  me: ShellScopeMe;
};

const ShellScopeContext = createContext<ShellScopeValue | null>(null);

/**
 * Authenticated-shell scope (admin / company / portal). Mounted once
 * at the shell level so `TopBar` can render the global action cluster
 * (Expirations, Starred, Chat, Profile) without each page passing
 * props through `PageHeader`.
 *
 * Unauthenticated shells (login, setup, error fallbacks) intentionally
 * skip the provider — `useShellScope()` returns `null` there and the
 * `TopBar` falls back to a bare breadcrumb row.
 */
export function ShellScopeProvider({
  value,
  children,
}: {
  value: ShellScopeValue;
  children: ReactNode;
}) {
  return (
    <ShellScopeContext.Provider value={value}>
      {children}
    </ShellScopeContext.Provider>
  );
}

export function useShellScope(): ShellScopeValue | null {
  return useContext(ShellScopeContext);
}
