import type { IntegrationTargetProvenance } from '@weavestream/shared';
import { Tag } from '../ui';

const STATE = {
  active: { label: 'Active source record', tone: 'ok' },
  stale: { label: 'Stale source record', tone: 'warn' },
  blocked: { label: 'Blocked source record', tone: 'danger' },
} as const;

/**
 * Collapse a target's provenance list to the strongest anomaly tone for
 * disclosure indicators: blocked → danger, stale → warn, all active →
 * undefined.
 */
export function provenanceAttention(
  provenance: readonly IntegrationTargetProvenance[],
): 'warn' | 'danger' | undefined {
  if (provenance.some((p) => p.state === 'blocked')) return 'danger';
  if (provenance.some((p) => p.state === 'stale')) return 'warn';
  return undefined;
}

export function ProvenanceBadge({ provenance }: { provenance: IntegrationTargetProvenance }) {
  const state = STATE[provenance.state];
  return (
    <section aria-label={`Provenance: ${state.label}`} style={{ border: '1px solid var(--line)', borderRadius: 7, padding: 10, fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Tag tone={state.tone}>{state.label}</Tag>
        <span style={{ color: 'var(--muted)' }}>{provenance.ownership === 'breeze' ? 'Source-owned' : 'Weavestream-owned'}</span>
      </div>
      <strong style={{ display: 'block', marginTop: 8 }}>
        {provenance.sourceLabel} · {provenance.sourceResource}
      </strong>
      <dl style={{ margin: '2px 0 0' }}>
        <DateTerm label="First seen" value={provenance.firstSeenAt} />
        <DateTerm label="Last seen" value={provenance.lastSeenAt} />
        <DateTerm
          label="Last synchronized"
          value={provenance.lastSyncedAt}
          last={!provenance.staleSince}
        />
        {provenance.staleSince && <DateTerm label="Stale since" value={provenance.staleSince} last />}
      </dl>
    </section>
  );
}

function DateTerm({ label, value, last }: { label: string; value: string | null; last?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '6px 0',
        borderBottom: last ? 'none' : '1px solid var(--line)',
        fontSize: 12,
      }}
    >
      <dt
        style={{
          flex: 1,
          minWidth: 0,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          fontSize: 10.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          color: 'var(--text-2)',
          textAlign: 'right',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value ? new Date(value).toLocaleString() : 'Never'}
      </dd>
    </div>
  );
}
