/**
 * Per-tab last-location restoration.
 *
 * **This is not a native navigation stack**, and the distinction matters
 * for what you can expect from it. Each tab remembers the *one* path it
 * was last on; tapping that tab returns there. Browser history stays
 * what it always was — chronological across tabs — so back/hardware-back
 * walks the order things were actually visited, not a per-tab stack.
 * That is the platform-standard PWA behaviour, and it is why there is no
 * custom hardware-back handler: in standalone display mode the system
 * back button already drives history, and a second handler is how you
 * get double navigation.
 *
 * Memory-only, so a reload lands on tab roots. Persisting it would mean
 * restoring a deep link into an org the user may no longer be scoped to,
 * for no real gain.
 */

export const TAB_IDS = ['passwords', 'articles', 'assets', 'more'] as const;
export type TabId = (typeof TAB_IDS)[number];

export const TAB_ROOTS: Record<TabId, string> = {
  passwords: '/passwords',
  articles: '/articles',
  assets: '/assets',
  more: '/more',
};

export interface RememberedLocation {
  path: string;
  /**
   * Search params to restore with the path — the passwords list's
   * filter chips live in `?folder=`/`?view=`, and returning to a tab
   * without them silently unfilters the list. The `sheet` overlay
   * param is never remembered (the Shell strips it before calling
   * `rememberLocation`) — restoring a tab must not reopen a sheet.
   */
  search?: Record<string, unknown>;
}

const remembered = new Map<TabId, RememberedLocation>();

/**
 * Which tab a path belongs to.
 *
 * Matches on the first path segment rather than a prefix compare, and
 * tolerates the `/m` basepath being present or absent — TanStack Router
 * reports router-relative paths, but the same helper is called with raw
 * `window.location.pathname` in tests.
 */
export function tabIdForPath(pathname: string): TabId | null {
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0] === 'm' ? segments[1] : segments[0];
  return TAB_IDS.find((id) => id === first) ?? null;
}

/** Record where a tab currently is, so a later tap on it comes back. */
export function rememberLocation(
  pathname: string,
  search?: Record<string, unknown>,
): void {
  const tab = tabIdForPath(pathname);
  if (!tab) return;
  const hasSearch = search !== undefined && Object.keys(search).length > 0;
  remembered.set(tab, {
    path: pathname,
    search: hasSearch ? search : undefined,
  });
}

/** Where tapping `tab` should go: its remembered location, else its root. */
export function rememberedLocation(tab: TabId): RememberedLocation {
  return remembered.get(tab) ?? { path: TAB_ROOTS[tab] };
}

/**
 * Forget every remembered path.
 *
 * Called on an org switch. Clearing *all* tabs rather than just the
 * visible one is the point: a remembered `/assets/<id>` in a background
 * tab belongs to the previous org, and restoring it later would show one
 * client's record under another client's header.
 */
export function clearRememberedLocations(): void {
  remembered.clear();
}

/**
 * Whether the tab bar should be hidden for this path.
 *
 * The create/edit forms are ordinary routed pages that own the whole
 * viewport (Cancel / Save top bar, keyboard below). Hiding the bar at the
 * shell beats rendering a fixed overlay on top of it: there is nothing
 * focusable left behind the form, so no dialog semantics, focus trap, or
 * scroll lock are needed, and hardware back keeps working untouched.
 *
 * Segment-based like `tabIdForPath`, tolerating the `/m` basepath for the
 * same reason. New full-viewport routes are appended here deliberately.
 */
const FORM_ROUTE_TABS: ReadonlySet<string> = new Set(['passwords', 'assets']);

export function hideTabBarFor(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] === 'm') segments.shift();
  // The launcher (and the index redirect that lands on it) is the
  // org-free home — the tab bar IS the "inside a client" chrome, so it
  // must not render there (Phase 5b). This also stops the redirect
  // frame from flashing a tab bar.
  if (segments.length === 0 || segments[0] === 'app') return true;
  // The search screen is 2b's full-screen takeover — field row where the
  // header was, results below, no tab bar while searching.
  if (segments[0] === 'search') return true;
  if (!FORM_ROUTE_TABS.has(segments[0] ?? '')) return false;
  if (segments.length === 2 && segments[1] === 'new') return true;
  return segments.length === 3 && segments[2] === 'edit';
}
