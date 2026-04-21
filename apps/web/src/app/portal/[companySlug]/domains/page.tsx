import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'Domains' };

import {
  getMe,
  listDomains,
  type MonitoredDomain,
} from '../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Icon, Panel, Tag } from '../../../../components/ui';

/**
 * Portal — read-only list of the company's domains. The API already
 * filters out non-`visibleToClients` rows for CLIENT_USER, so we just
 * render whatever comes back. No "Check now" / "Edit" / "Archive"
 * controls here: portal users cannot mutate domain state.
 */
export default async function PortalDomainsPage({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  const me = (await getMe())!;
  const membership = me.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) notFound();
  const companyId = membership.company.id;

  const page = await listDomains(companyId, { limit: 100 });

  return (
    <>
      <PageHeader
        crumbs={[
          { label: membership.company.name },
          { label: 'Domains' },
        ]}
        title="Domains"
        description="Health of the domains your team uses — WHOIS expiry, SSL/TLS certificate validity, and DNS."
      />
      <PageBody>
        <Panel
          title={
            <span>
              {page.items.length} domain{page.items.length === 1 ? '' : 's'}
            </span>
          }
          noPad
        >
          {page.items.length === 0 ? <EmptyState /> : <DomainList items={page.items} />}
        </Panel>
      </PageBody>
    </>
  );
}

function DomainList({ items }: { items: MonitoredDomain[] }) {
  return (
    <>
      <div className="hide-on-mobile" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--dim)' }}>
              <th style={thStyle}>Hostname</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>WHOIS expires</th>
              <th style={thStyle}>TLS expires</th>
              <th style={thStyle}>Last checked</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ ...tdStyle, fontWeight: 500 }}>{d.hostname}</td>
                <td style={tdStyle}>
                  <StatusTag status={d.latestStatus} />
                </td>
                <td style={monoCell} title={fmtRelativeFuture(d.whoisExpiresAt)}>
                  {fmtDate(d.whoisExpiresAt)}
                </td>
                <td style={monoCell} title={fmtRelativeFuture(d.tlsExpiresAt)}>
                  {fmtDate(d.tlsExpiresAt)}
                </td>
                <td style={monoCell}>{fmtRelativePast(d.lastCheckedAt) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul
        className="mobile-only"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {items.map((d) => (
          <li
            key={d.id}
            style={{
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: 12,
              background: 'var(--panel)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  flex: 1,
                  fontWeight: 600,
                  fontSize: 14,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {d.hostname}
              </span>
              <StatusTag status={d.latestStatus} />
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 6,
              }}
            >
              <MobileField label="WHOIS" value={fmtDate(d.whoisExpiresAt)} />
              <MobileField label="TLS" value={fmtDate(d.tlsExpiresAt)} />
              <MobileField
                label="Last checked"
                value={fmtRelativePast(d.lastCheckedAt) ?? '—'}
              />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function MobileField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          color: 'var(--dim)',
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function StatusTag({ status }: { status: MonitoredDomain['latestStatus'] }) {
  switch (status) {
    case 'OK':
      return <Tag tone="ok">OK</Tag>;
    case 'EXPIRING':
      return <Tag tone="warn">Expiring soon</Tag>;
    case 'EXPIRED':
      return <Tag tone="danger">Expired</Tag>;
    case 'FAIL':
      return <Tag tone="danger">Needs attention</Tag>;
    case 'UNKNOWN':
    default:
      return <Tag tone="outline">Pending</Tag>;
  }
}

function EmptyState() {
  return (
    <div
      style={{
        padding: 48,
        textAlign: 'center',
        color: 'var(--muted)',
        fontSize: 13,
      }}
    >
      <div style={{ fontSize: 24, marginBottom: 8 }}>
        <Icon.globe size={24} />
      </div>
      No domains are being tracked for your workspace yet.
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 10);
}

function fmtRelativeFuture(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return 'expires today';
  if (days < 30) return `in ${days} days`;
  if (days < 365) return `in ${Math.round(days / 30)} months`;
  return `in ${Math.round(days / 365)} years`;
}

function fmtRelativePast(iso: string | null): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} d ago`;
}

const thStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  borderBottom: '1px solid var(--line)',
};

const tdStyle: React.CSSProperties = { padding: '12px 14px', verticalAlign: 'middle' };
const monoCell: React.CSSProperties = {
  ...tdStyle,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--muted)',
};
