'use client';

/**
 * Last-visited companies for the scope pill's switcher menu
 * (`ScopePill` in `components/shell/top-bar.tsx`). Per-user and
 * server-side (`/me/recent-companies`, Redis-backed): the list
 * follows the account, so nothing tenant-shaped persists in the
 * browser profile of a shared machine, and the API resolves names
 * through the actor's access scope on every read. The menu fetches
 * the list on open via `apiFetch`, like the starred popover.
 */

import { apiFetch } from './api';

export type RecentCompany = { id: string; name: string };

// One-time scrub: a short-lived, never-released build stored recents
// (company ids + names) under this localStorage key before review
// moved them server-side. Only dev browsers that ran that build hold
// it. Safe to delete this block after a release or two.
try {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem('weavestream:companies:recent');
  }
} catch {
  // Storage disabled — nothing to scrub.
}

/**
 * Best-effort fire-and-forget; a failure is fine, the next navigation
 * records naturally. Deliberately NO client-side dedupe: the server
 * update is idempotent (dedupe-to-front), and a module-global "last
 * recorded" guard would survive a client-side logout/login, so the
 * next account's first visit to the same company would never reach
 * its own history. The pill's mount effect already bounds this to one
 * PUT per company-page navigation.
 */
export function recordRecentCompany(companyId: string): void {
  apiFetch(`/me/recent-companies/${companyId}`, { method: 'PUT' }).catch(() => {
    // Network failure — nothing to do for a navigation hint.
  });
}
