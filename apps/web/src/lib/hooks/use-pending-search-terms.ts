import { useState } from 'react';

/**
 * The search terms an asset list should build on: the URL's terms, or,
 * while a navigation is still in flight, the terms it last pushed.
 *
 * Without this, a 2nd term entered before the 1st navigation lands is
 * added to the old URL terms, and the 1st term is lost (`dell` then
 * `lab` would leave only `lab`). `navigating` is the `isPending` of the
 * transition that wraps `router.push`.
 *
 * The remembered terms are dropped as soon as navigation settles. They
 * belong only to the navigation that pushed them: kept longer, a later
 * navigation (Back, then removing a field-filter pill) would bring an
 * old term back.
 *
 * Returns the terms to use and the function to call with each pushed list.
 */
export function usePendingSearchTerms(
  urlTerms: readonly string[],
  navigating: boolean,
): [readonly string[], (pushed: readonly string[]) => void] {
  const [pushed, setPushed] = useState<readonly string[] | null>(null);
  // Adjusting state during render (React's documented pattern for state
  // derived from a prop): React re-renders at once with the cleared value,
  // before anything is shown.
  if (!navigating && pushed !== null) setPushed(null);
  return [navigating && pushed ? pushed : urlTerms, setPushed];
}
