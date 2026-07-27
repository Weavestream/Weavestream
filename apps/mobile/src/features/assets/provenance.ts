import type { IntegrationTargetProvenance } from '@weavestream/shared';

/**
 * Provenance → attention mapping for the detail screen's T2 disclosure.
 * Mirror of desktop's `provenanceAttention` (provenance-badge.tsx):
 * blocked → danger, stale → warn. The dot rides on the collapsed
 * ShowMore label so collapsing never buries a sync problem.
 */
export function provenanceDot(
  provenance: IntegrationTargetProvenance[],
): 'danger' | 'warn' | null {
  if (provenance.some((p) => p.state === 'blocked')) return 'danger';
  if (provenance.some((p) => p.state === 'stale')) return 'warn';
  return null;
}

/** Worst-state summary row for the T2 card; null when not integration-managed. */
export function provenanceSummary(
  provenance: IntegrationTargetProvenance[],
): { label: string; tone?: 'danger' | 'warn' } | null {
  if (provenance.length === 0) return null;
  if (provenance.some((p) => p.state === 'blocked')) {
    return { label: 'Sync blocked', tone: 'danger' };
  }
  if (provenance.some((p) => p.state === 'stale')) {
    return { label: 'Sync stale', tone: 'warn' };
  }
  return { label: 'Synced' };
}
