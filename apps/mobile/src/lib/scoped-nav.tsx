import {
  Link,
  useLocation,
  useNavigate,
  type LinkProps,
} from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';
import { isOrgFreeEntry, readOrgStamp as readStamp } from './org-free';
import { useOrgScope } from './org-scope';
import { TAB_ROOTS, tabIdForPath } from './tab-stacks';

/**
 * Org-stamped navigation.
 *
 * Every entry this app pushes carries the org it was created under, in
 * history state. The stale-scope guard in the tab layout then compares a
 * popped entry's stamp to the current org and redirects to a tab root
 * when they differ — otherwise browser back would resurrect one client's
 * detail screen under another client's header.
 *
 * **The stamp is the org id, not a counter.** History state survives a
 * reload but an in-memory counter restarts at zero, so a counter would
 * make pre-reload entries collide with post-reload numbering — some
 * stale entries reading as current and vice versa. An id is stable and
 * collision-free by construction.
 *
 * Raw `Link` / `useNavigate` are banned everywhere else in `src` by
 * eslint (see eslint.config.mjs), with only `router.tsx` and this file
 * exempt, so a new component cannot quietly skip the stamp.
 */

export interface OrgStamp {
  orgId: string | null;
}

// The stamp reader (and the org-free predicates built on it) live in
// `org-free.ts` so `org-scope` can boot on them without an import
// cycle; re-exported here because this file is the stamp's home API.
export { readOrgStamp } from './org-free';

/**
 * Whether this history entry was pushed **directly from its parent
 * screen** (list → detail, detail → edit), stamped at push time via
 * `upIsBack`.
 *
 * The labeled back chevron ("‹ Passwords") is an UP affordance, but
 * browser history is chronological ACROSS tabs — after
 * detail → More-tab → Passwords-tab, the current detail entry's
 * previous history entry is the More screen, so a blind
 * `history.back()` would send "‹ Passwords" to More. `useBackOr` pops
 * history only when this stamp says the parent really is one entry
 * behind; otherwise it navigates structurally.
 */
export function readUpIsBack(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false;
  return (state as Record<string, unknown>).upIsBack === true;
}

/**
 * The label the pushed entry's back chevron should show when it pops —
 * stamped alongside `upIsBack` by the screen that pushed it.
 *
 * Exists for pushes whose parent is NOT the structural one: a search
 * result opens `/passwords/<id>`, so popping returns to Search, but the
 * detail screen's structural label says "Passwords". Same positional
 * semantics as `upIsBack`: meaningful only for the entry it was written
 * on, so a push that doesn't supply it must not inherit it.
 */
export function readBackLabel(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const value = (state as Record<string, unknown>).backLabel;
  return typeof value === 'string' && value ? value : undefined;
}

export interface ScopedNavigateOptions {
  /**
   * Target path. Typed as `string` rather than the router's route-literal
   * union on purpose: remembered tab locations are read back out of
   * `location.pathname` at runtime (`/passwords/<id>`), so they cannot be
   * literals. They are valid by construction — the router produced them.
   */
  to: string;
  replace?: boolean;
  search?: Record<string, unknown>;
  /**
   * Stamp this org id instead of the one currently in context.
   *
   * Required by `switchOrg`: it navigates on the same tick as the state
   * update, when the context value in this closure is still the *old*
   * org. Passing the new id explicitly is what keeps the first
   * post-switch entry from being stamped stale and instantly bounced by
   * the guard.
   */
  orgId?: string | null;
  /**
   * Mark the pushed entry as "the parent screen is one history entry
   * behind" — set ONLY when pushing a child directly from its parent
   * (list → detail, detail → edit). See `readUpIsBack`. Survives a
   * later `replace` (create form → new detail) because the state
   * updater spreads the previous entry's state.
   */
  upIsBack?: boolean;
  /**
   * Label for the pushed entry's back chevron when it pops — set when
   * the pushing screen is not the target's structural parent (a search
   * result pushing a detail sets `backLabel: 'Search'`). Positional
   * like `upIsBack`: never inherited by a later push. See
   * `readBackLabel`.
   */
  backLabel?: string;
}

export function useScopedNavigate() {
  const navigate = useNavigate();
  const { currentOrg } = useOrgScope();

  return useCallback(
    ({ to, replace, search, orgId, upIsBack, backLabel }: ScopedNavigateOptions) => {
      const stampedOrgId = orgId !== undefined ? orgId : (currentOrg?.id ?? null);
      // One cast, for the `to: string` reason above. `state` uses the
      // updater form so the router's own internal keys survive.
      void navigate({
        to,
        replace,
        search,
        state: (prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev, orgId: stampedOrgId };
          // `upIsBack` is POSITIONAL ("my parent is one entry behind"),
          // and `prev` here is the entry being navigated AWAY from — so
          // a push must never inherit it (or a stamped detail would
          // leak the stamp onto the More tab and re-break the chevron),
          // while a replace keeps it (same stack position, e.g. the
          // create form replacing itself with the new detail).
          if (upIsBack) next.upIsBack = true;
          else if (!replace) delete next.upIsBack;
          // `backLabel` shares that positional contract: a push from the
          // search screen stamps "Search"; a later list-originated push
          // must not carry it forward or its chevron lies.
          if (backLabel) next.backLabel = backLabel;
          else if (!replace) delete next.backLabel;
          return next;
        },
      } as never);
    },
    [navigate, currentOrg],
  );
}

/**
 * `Link`, stamped. Same contract as the hook; use it for anything the
 * user should be able to long-press or open in a new tab.
 */
export function ScopedLink(props: LinkProps & { className?: string }) {
  const { currentOrg } = useOrgScope();
  const orgId = currentOrg?.id ?? null;
  return (
    <Link
      {...(props as LinkProps)}
      // Updater form, not an object literal: the router's parsed state
      // carries its own internal keys and replacing it wholesale drops
      // them.
      state={(prev) => ({ ...prev, orgId })}
    />
  );
}

/**
 * Redirect a history entry that belongs to a previous org.
 *
 * `switchOrg` clears every remembered tab location, but it cannot reach
 * into browser history — so pressing back after a switch would otherwise
 * restore one client's detail screen under another client's header.
 *
 * Lives here rather than in the shell because it is the read side of the
 * stamp written above, and keeping both in one file is what lets the
 * eslint ban on raw `useNavigate` cover every other module.
 *
 * Two conditions that are easy to get wrong:
 *
 *  - It waits for `scopeStatus === 'ready'`. While resolving, `currentOrg`
 *    is still null and every stamped entry would look stale — a plain
 *    reload would bounce to a tab root. `'error'` stands down for the same
 *    reason: a network failure is not evidence the scope changed.
 *  - An **unstamped** entry is *adopted*, not exempted. A first load or an
 *    external deep link is legitimate right now, so it is stamped in place
 *    with the resolved org rather than redirected. Leaving it unstamped
 *    would exempt it permanently: after navigating on and switching org, a
 *    long press of back could reach that entry and render the old org's
 *    detail screen under the new org's header.
 *
 * Phase 5b adds the org-free surfaces (launcher, global search):
 *
 *  - Org-free entries are EXEMPT from the mismatch bounce — popping from
 *    a cross-org hit's detail back to global search must not bounce to a
 *    tab root — and instead drive the arrival-clear effect below.
 *  - A scoped entry under a null context (zero orgs, or a stale org
 *    entry popped from under the launcher) redirects to the launcher —
 *    the app-level home for "no company in context".
 */
export function useStaleScopeGuard(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const { currentOrg, scopeStatus, clearOrg } = useOrgScope();

  const state = location.state;
  const pathname = location.pathname;
  const search = location.search;

  /**
   * Arrival-clear: settling on an org-free entry leaves org context.
   *
   * Deliberately keyed ONLY on location identity (plus the stable
   * `clearOrg` callback) and NEVER on `currentOrg` — on the commit where
   * `switchOrg` has already set the new org but the router still shows
   * `/app` (the launcher's select-org tick), this effect must NOT re-run
   * and wipe the fresh selection. `clearOrg` on an already-null
   * selection is an `Object.is` bail, so repeat runs are free.
   */
  useEffect(() => {
    if (isOrgFreeEntry(pathname, state)) clearOrg();
  }, [pathname, state, clearOrg]);

  useEffect(() => {
    if (scopeStatus !== 'ready') return;
    // Org-free entries are never adopted or bounced; the arrival-clear
    // effect above owns them.
    if (isOrgFreeEntry(pathname, state)) return;

    const stamped = readStamp(state);
    const currentId = currentOrg?.id ?? null;

    if (currentId === null) {
      // No company in context but a scoped path: herd to the launcher.
      // Covers the zero-org boot (every scoped screen would dead-end)
      // and stale org entries popped from under the launcher. `replace`
      // consumes the entry.
      void navigate({
        to: '/app',
        replace: true,
        state: (prev: Record<string, unknown>) => ({ ...prev, orgId: null }),
      } as never);
      return;
    }

    if (stamped === undefined) {
      // Adopt the entry: same location, now stamped. `replace` so no new
      // history entry appears, and the effect's next run sees a matching
      // stamp and stops.
      void navigate({
        to: pathname,
        search,
        replace: true,
        state: (prev: Record<string, unknown>) => ({ ...prev, orgId: currentId }),
      } as never);
      return;
    }

    if (stamped === currentId) return;

    const tab = tabIdForPath(pathname) ?? 'passwords';
    // Replaces rather than pushes, so the stale entry is consumed instead
    // of becoming another thing to press back through. The re-run after
    // this navigation sees a matching stamp and stops.
    void navigate({
      to: TAB_ROOTS[tab],
      replace: true,
      state: (prev: Record<string, unknown>) => ({ ...prev, orgId: currentId }),
    } as never);
  }, [state, pathname, search, currentOrg, scopeStatus, navigate]);
}
