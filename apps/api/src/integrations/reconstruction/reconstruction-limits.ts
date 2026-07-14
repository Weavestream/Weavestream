/** Stable, count-based runtime bounds used by reconstruction sync and tests. */
export const RECONSTRUCTION_RUNTIME_LIMITS = {
  recordsPerPage: 10_000,
  pagesPerTraversal: 1_000,
  gapsPerPage: 1_000,
  conflictsPerRun: 10_000,
  nativeMutationBatch: 500,
} as const;
