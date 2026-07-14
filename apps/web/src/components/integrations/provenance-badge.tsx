import type { IntegrationTargetProvenance } from '@weavestream/shared';
import { Tag } from '../ui';

const STATE = {
  active: { label: 'Active source record', tone: 'ok' },
  stale: { label: 'Stale source record', tone: 'warn' },
  blocked: { label: 'Blocked source record', tone: 'danger' },
} as const;

export function ProvenanceBadge({ provenance }: { provenance: IntegrationTargetProvenance }) {
  const state = STATE[provenance.state];
  return (
    <section aria-label={`Provenance: ${state.label}`} style={{ border: '1px solid var(--line)', borderRadius: 7, padding: 10, fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
        <Tag tone={state.tone}>{state.label}</Tag>
        <strong>{provenance.sourceLabel} · {provenance.sourceResource}</strong>
        <span style={{ color: 'var(--muted)' }}>{provenance.ownership === 'breeze' ? 'Source-owned' : 'Weavestream-owned'}</span>
      </div>
      <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 5 }}>
        <DateTerm label="First seen" value={provenance.firstSeenAt} />
        <DateTerm label="Last seen" value={provenance.lastSeenAt} />
        <DateTerm label="Last synchronized" value={provenance.lastSyncedAt} />
        {provenance.staleSince && <DateTerm label="Stale since" value={provenance.staleSince} />}
      </dl>
    </section>
  );
}

function DateTerm({ label, value }: { label: string; value: string | null }) {
  return <div><dt style={{ color: 'var(--muted)' }}>{label}</dt><dd style={{ margin: 0 }}>{value ? new Date(value).toLocaleString() : 'Never'}</dd></div>;
}
