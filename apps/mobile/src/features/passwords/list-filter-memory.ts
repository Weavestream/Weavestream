import type { PasswordListFilter } from './PasswordFilterChips';

/**
 * The list screen's last filter, for the detail/form screens' UP
 * navigation. When "‹ Passwords" cannot pop history (the entry wasn't
 * pushed straight from the list — e.g. after a tab-switch round trip),
 * it navigates structurally and re-applies this filter so "back to the
 * list" doesn't quietly mean "back to an unfiltered list".
 *
 * Keyed by org so a stale filter (a folder id from the previous
 * client) can never leak across an org switch. Memory-only, like the
 * tab-stack memory.
 */
let rememberedOrgId: string | null = null;
let rememberedFilter: PasswordListFilter = {};

export function rememberListFilter(orgId: string, filter: PasswordListFilter): void {
  rememberedOrgId = orgId;
  rememberedFilter = filter;
}

/** The remembered filter as search params, or undefined when empty/stale. */
export function recallListFilter(
  orgId: string | null,
): Record<string, unknown> | undefined {
  if (orgId === null || orgId !== rememberedOrgId) return undefined;
  const entries = Object.entries(rememberedFilter).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Test-only. */
export function resetListFilterMemoryForTests(): void {
  rememberedOrgId = null;
  rememberedFilter = {};
}
