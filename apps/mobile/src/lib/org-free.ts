/**
 * Org-free surfaces (Phase 5b): the launcher and global search render
 * with NO company in context — no tab bar, no org header, cross-org
 * data. These predicates are the single definition of "org-free",
 * consumed by both sides of the scope machinery:
 *
 *  - `org-scope.tsx` boots without resolving an org for org-free
 *    entries (the launcher must not silently adopt a company);
 *  - `scoped-nav.tsx`'s stale-scope guard exempts org-free entries from
 *    the mismatch bounce and clears the in-memory org on arrival.
 *
 * Lives in its own module so `org-scope` (which `scoped-nav` imports)
 * can use it without an import cycle.
 */

/** Read the org stamp off a history entry. `undefined` = unstamped. */
export function readOrgStamp(state: unknown): string | null | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const value = (state as Record<string, unknown>).orgId;
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function leadingSegment(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  // Tolerate the `/m` basepath, same as `tabIdForPath`.
  if (segments[0] === 'm') segments.shift();
  return segments[0] ?? '';
}

/**
 * Paths that are org-free by construction: the launcher (`/app`) and
 * the index redirect that lands on it.
 */
export function isOrgFreePath(pathname: string): boolean {
  const seg = leadingSegment(pathname);
  return seg === '' || seg === 'app';
}

/**
 * Whether a concrete history entry is org-free. `/search` is org-free
 * only when its entry carries an explicit `orgId: null` stamp (a push
 * from the launcher, or a reload of one — history state survives
 * reloads); an unstamped or org-stamped search entry is the ordinary
 * in-org search screen.
 */
export function isOrgFreeEntry(pathname: string, state: unknown): boolean {
  if (isOrgFreePath(pathname)) return true;
  return leadingSegment(pathname) === 'search' && readOrgStamp(state) === null;
}
