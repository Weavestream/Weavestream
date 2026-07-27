import { useCanGoBack, useLocation, useRouter } from '@tanstack/react-router';
import { readBackLabel, readUpIsBack, useScopedNavigate } from './scoped-nav';

/**
 * The labeled back affordance ("‹ Passwords", Cancel) — an **up**
 * navigation, not a history pop.
 *
 * Browser history is chronological across tabs (see tab-stacks), so
 * `history.back()` from a detail screen can land on a *different tab*:
 * detail → More tab → Passwords tab re-pushes the detail, and its
 * previous entry is now More. A chevron that says "Passwords" must not
 * go there.
 *
 * So: pop history ONLY when this entry carries the `upIsBack` stamp —
 * written at push time by the parent screen, proving the parent is one
 * entry behind (which also keeps its filter params alive on the way
 * back). Anything else gets a structural replace-navigation to
 * `fallbackTo` (+ `fallbackSearch`, e.g. the list's remembered
 * filters). Hardware/browser back stays chronological everywhere —
 * this only disciplines the in-app affordance.
 */
export function useBackOr(
  fallbackTo: string,
  fallbackSearch?: Record<string, unknown>,
): () => void {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useScopedNavigate();
  const location = useLocation();
  const upIsBack = readUpIsBack(location.state);

  return () => {
    if (upIsBack && canGoBack) router.history.back();
    else navigate({ to: fallbackTo, replace: true, search: fallbackSearch });
  };
}

/**
 * The label for that affordance, honest about where it will actually go.
 *
 * A stamped `backLabel` (a search result stamps "Search") applies only
 * when `useBackOr` would really pop history — the same
 * `upIsBack && canGoBack` predicate. In every other case the chevron
 * performs the structural navigation, so it shows the structural label
 * ("Passwords"), including on cold deep links where no stamp exists.
 */
export function useBackLabel(structuralLabel: string): string {
  const canGoBack = useCanGoBack();
  const location = useLocation();
  const upIsBack = readUpIsBack(location.state);
  const stamped = readBackLabel(location.state);

  return upIsBack && canGoBack && stamped ? stamped : structuralLabel;
}
