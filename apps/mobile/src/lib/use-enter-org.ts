import { useCallback } from 'react';
import { useOrgScope, type Org } from './org-scope';
import { useScopedNavigate } from './scoped-nav';

/**
 * Enter an organization: the one coordinated step shared by the shell's
 * org sheet and the launcher (Phase 5b).
 *
 * `switchOrg` updates scope + persistence + cache invalidation; the
 * paired navigation stamps the NEW org id **explicitly from `org.id`**
 * because this closure still holds the previous org on the switch tick —
 * a stamp taken from context would mark the very first post-switch
 * entry stale and the guard would bounce the user straight back out.
 *
 * `history` is the caller's choice:
 *  - the shell **replaces** (consuming the `?sheet=org` entry so back
 *    doesn't re-open the switcher) and stays on the active tab's root;
 *  - the launcher **pushes**, so the launcher entry stays in history
 *    and system/hardware Back from the org's tab root returns to it.
 */
export function useEnterOrg() {
  const { switchOrg } = useOrgScope();
  const navigate = useScopedNavigate();

  return useCallback(
    (
      org: Org,
      opts: {
        to: string;
        history: 'push' | 'replace';
        /** Positional back stamps for pushes whose parent is the pushing
         *  screen (a global-search hit stamps `upIsBack` + "Search"). */
        upIsBack?: boolean;
        backLabel?: string;
      },
    ) => {
      switchOrg(org);
      navigate({
        to: opts.to,
        orgId: org.id,
        replace: opts.history === 'replace',
        upIsBack: opts.upIsBack,
        backLabel: opts.backLabel,
      });
    },
    [switchOrg, navigate],
  );
}
