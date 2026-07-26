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

const remembered = new Map<TabId, string>();

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
export function rememberLocation(pathname: string): void {
  const tab = tabIdForPath(pathname);
  if (tab) remembered.set(tab, pathname);
}

/** Where tapping `tab` should go: its remembered path, else its root. */
export function rememberedLocation(tab: TabId): string {
  return remembered.get(tab) ?? TAB_ROOTS[tab];
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
