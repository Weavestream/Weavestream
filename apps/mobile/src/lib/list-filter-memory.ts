/**
 * Org-keyed memory of a list screen's last filter, for the detail/form
 * screens' UP navigation. When "‹ List" cannot pop history (the entry
 * wasn't pushed straight from the list — e.g. after a tab-switch round
 * trip), it navigates structurally and re-applies this filter so "back
 * to the list" doesn't quietly mean "back to an unfiltered list".
 *
 * Keyed by org so a stale filter (a folder id from the previous client)
 * can never leak across an org switch. Memory-only, like the tab-stack
 * memory. One factory, one invariant — passwords and articles each hold
 * an instance (features must not import from each other).
 *
 * `T extends object` (not `Record<string, unknown>`): filter shapes are
 * declared as interfaces, which have no implicit index signature and
 * would fail the stricter constraint.
 */
export function createListFilterMemory<T extends object>() {
  let rememberedOrgId: string | null = null;
  let rememberedFilter: T = {} as T;

  function remember(orgId: string, filter: T): void {
    rememberedOrgId = orgId;
    rememberedFilter = filter;
  }

  /** The remembered filter as search params, or undefined when empty/stale. */
  function recall(orgId: string | null): Record<string, unknown> | undefined {
    if (orgId === null || orgId !== rememberedOrgId) return undefined;
    const entries = Object.entries(rememberedFilter).filter(
      ([, v]) => v !== undefined,
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  /** Test-only. */
  function resetForTests(): void {
    rememberedOrgId = null;
    rememberedFilter = {} as T;
  }

  return { remember, recall, resetForTests };
}
