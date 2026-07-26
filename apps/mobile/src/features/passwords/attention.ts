import type { PasswordSummary } from '@weavestream/shared';

/**
 * Client-side "needs attention" predicate for the list chip, mirroring
 * the ONE existing implementation of this rule — the desktop company
 * nav badge (`apps/web/src/app/admin/companies/[id]/layout.tsx`):
 * already expired, rotation overdue, or known-pwned. Weak-but-unpwned
 * is deliberately not counted, matching desktop.
 *
 * Computed client-side because the server offers nothing usable here:
 * there is no attention endpoint, and the list's `?stale=` filter
 * catches only `expiresAt <= now` (and OR-combines with `q`) — do not
 * "optimize" this back onto the API.
 */

const DAY_MS = 86_400_000;

/** The "expiring soon" window for the show-more warn dot. */
export const ATTENTION_WARN_WINDOW_DAYS = 30;

function rotationDueAt(p: PasswordSummary): number | null {
  if (!p.lastRotatedAt || !p.rotationReminderDays) return null;
  return Date.parse(p.lastRotatedAt) + p.rotationReminderDays * DAY_MS;
}

export function needsAttention(p: PasswordSummary, now: number): boolean {
  if (p.archivedAt) return false;
  if (p.expiresAt && Date.parse(p.expiresAt) <= now) return true;
  const due = rotationDueAt(p);
  if (due !== null && due <= now) return true;
  // `null` pwnedCount means "not checked yet", which must not count —
  // the async HIBP worker fills it in seconds after a save.
  return (p.pwnedCount ?? 0) > 0;
}

export type AttentionTier = 'danger' | 'warn' | null;

/**
 * Tier for the detail screen's collapsed "show more" indicator dot.
 * Covers ONLY what the disclosure hides (expiry / rotation): danger
 * when overdue, warn when due within the 30-day window. `pwnedCount`
 * is excluded on purpose — it is already visible in the strength row,
 * so a dot for it would point at nothing hidden.
 */
export function attentionTier(p: PasswordSummary, now: number): AttentionTier {
  if (p.archivedAt) return null;

  const expiresAt = p.expiresAt ? Date.parse(p.expiresAt) : null;
  const due = rotationDueAt(p);

  if ((expiresAt !== null && expiresAt <= now) || (due !== null && due <= now)) {
    return 'danger';
  }

  const soon = now + ATTENTION_WARN_WINDOW_DAYS * DAY_MS;
  if ((expiresAt !== null && expiresAt <= soon) || (due !== null && due <= soon)) {
    return 'warn';
  }

  return null;
}
