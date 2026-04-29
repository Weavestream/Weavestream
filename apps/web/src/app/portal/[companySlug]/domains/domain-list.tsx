'use client';

import {
  DataTable,
  type DataColumn,
  MobileCardRow,
  Tag,
} from '../../../../components/ui';
import type { MonitoredDomain } from '../../../../lib/server-api';

/**
 * Portal-side domains list. Read-only — the API already filters out
 * non-`visibleToClients` entries for CLIENT_USER, so we just display
 * what we get and let users sort by any column.
 */
export function DomainList({ items }: { items: MonitoredDomain[] }) {
  return (
    <DataTable
      columns={domainColumns()}
      rows={items}
      renderMobileCard={(d) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
          <MobileCardRow label="WHOIS" mono>
            {fmtDate(d.whoisExpiresAt)}
          </MobileCardRow>
          <MobileCardRow label="TLS" mono>
            {fmtDate(d.tlsExpiresAt)}
          </MobileCardRow>
          <MobileCardRow label="Checked" mono>
            {fmtRelativePast(d.lastCheckedAt) ?? '—'}
          </MobileCardRow>
        </div>
      )}
    />
  );
}

function domainColumns(): DataColumn<MonitoredDomain>[] {
  const STATUS_RANK: Record<MonitoredDomain['latestStatus'], number> = {
    OK: 0,
    EXPIRING: 1,
    EXPIRED: 2,
    FAIL: 3,
    UNKNOWN: 4,
  };
  return [
    {
      id: 'hostname',
      header: 'Hostname',
      width: 280,
      sortValue: (d) => d.hostname.toLowerCase(),
      render: (d) => <span style={{ fontWeight: 500 }}>{d.hostname}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      width: 130,
      sortValue: (d) => STATUS_RANK[d.latestStatus],
      render: (d) => <StatusTag status={d.latestStatus} />,
    },
    {
      id: 'whois',
      header: 'WHOIS expires',
      width: 140,
      mono: true,
      sortValue: (d) => (d.whoisExpiresAt ? new Date(d.whoisExpiresAt) : null),
      render: (d) => (
        <span style={{ color: 'var(--muted)' }} title={fmtRelativeFuture(d.whoisExpiresAt)}>
          {fmtDate(d.whoisExpiresAt)}
        </span>
      ),
    },
    {
      id: 'tls',
      header: 'TLS expires',
      width: 140,
      mono: true,
      sortValue: (d) => (d.tlsExpiresAt ? new Date(d.tlsExpiresAt) : null),
      render: (d) => (
        <span style={{ color: 'var(--muted)' }} title={fmtRelativeFuture(d.tlsExpiresAt)}>
          {fmtDate(d.tlsExpiresAt)}
        </span>
      ),
    },
    {
      id: 'lastChecked',
      header: 'Last checked',
      width: 140,
      mono: true,
      sortValue: (d) => (d.lastCheckedAt ? new Date(d.lastCheckedAt) : null),
      render: (d) => (
        <span style={{ color: 'var(--muted)' }}>
          {fmtRelativePast(d.lastCheckedAt) ?? '—'}
        </span>
      ),
    },
  ];
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
