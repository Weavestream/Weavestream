import type { PasswordVersionSummary } from '@weavestream/shared';

/** Newest version first, without mutating the server's array. */
export function sortVersionsNewestFirst(
  versions: readonly PasswordVersionSummary[],
): PasswordVersionSummary[] {
  return [...versions].sort((a, b) => b.version - a.version);
}

/** Collapsed, the panel shows only the latest version. */
export function visibleVersions(
  sorted: readonly PasswordVersionSummary[],
  expanded: boolean,
): readonly PasswordVersionSummary[] {
  return expanded ? sorted : sorted.slice(0, 1);
}
