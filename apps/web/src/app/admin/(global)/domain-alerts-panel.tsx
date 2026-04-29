'use client';

import Link from 'next/link';
import {
  DataTable,
  type DataColumn,
  MobileCardRow,
  Panel,
  Tag,
} from '../../../components/ui';
import type { DomainAlert } from '../../../lib/server-api';

/**
 * Cross-company domain alerts — surfaces EXPIRING / EXPIRED / FAIL
 * domains on the global dashboard so SUPER_ADMIN sees trouble at a
 * glance. Server pre-sorts by urgency; we keep that as the default
 * sort and let users override per column.
 */
export function DomainAlertsPanel({ alerts }: { alerts: DomainAlert[] }) {
  return (
    <Panel
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          Domain alerts
          {alerts.length > 0 && (
            <Tag tone="danger" dot>
              {alerts.length}
            </Tag>
          )}
        </span>
      }
      noPad
    >
      {alerts.length === 0 ? (
        <div
          style={{
            padding: 24,
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          All monitored domains are healthy.
        </div>
      ) : (
        <DataTable
          columns={alertColumns()}
          rows={alerts.map((a) => ({ ...a, id: a.domainId }))}
          renderMobileCard={(a) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Link
                  href={`/admin/companies/${a.companyId}/domains/${a.domainId}`}
                  style={{
                    flex: 1,
                    color: 'var(--text)',
                    fontWeight: 600,
                    fontSize: 14,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {a.hostname}
                </Link>
                <AlertStatus status={a.status} />
              </div>
              <Link
                href={`/admin/companies/${a.companyId}`}
                style={{
                  color: 'var(--muted)',
                  fontSize: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {a.companyName}
              </Link>
              <MobileCardRow label="WHOIS" mono>
                {fmtDate(a.whoisExpiresAt)}
              </MobileCardRow>
              <MobileCardRow label="TLS" mono>
                {fmtDate(a.tlsExpiresAt)}
              </MobileCardRow>
            </div>
          )}
        />
      )}
    </Panel>
  );
}

type Row = DomainAlert & { id: string };

function alertColumns(): DataColumn<Row>[] {
  const STATUS_RANK: Partial<Record<DomainAlert['status'], number>> = {
    EXPIRING: 0,
    EXPIRED: 1,
    FAIL: 2,
  };
  return [
    {
      id: 'hostname',
      header: 'Hostname',
      width: 280,
      sortValue: (a) => a.hostname.toLowerCase(),
      render: (a) => (
        <Link
          href={`/admin/companies/${a.companyId}/domains/${a.domainId}`}
          style={{ color: 'var(--text)', fontWeight: 500 }}
        >
          {a.hostname}
        </Link>
      ),
    },
    {
      id: 'company',
      header: 'Company',
      width: 220,
      sortValue: (a) => a.companyName.toLowerCase(),
      render: (a) => (
        <Link
          href={`/admin/companies/${a.companyId}`}
          style={{ color: 'var(--muted)' }}
        >
          {a.companyName}
        </Link>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 110,
      sortValue: (a) => STATUS_RANK[a.status] ?? 99,
      render: (a) => <AlertStatus status={a.status} />,
    },
    {
      id: 'whois',
      header: 'WHOIS expires',
      width: 140,
      mono: true,
      sortValue: (a) => (a.whoisExpiresAt ? new Date(a.whoisExpiresAt) : null),
      render: (a) => (
        <span style={{ color: 'var(--muted)' }}>{fmtDate(a.whoisExpiresAt)}</span>
      ),
    },
    {
      id: 'tls',
      header: 'TLS expires',
      width: 140,
      mono: true,
      sortValue: (a) => (a.tlsExpiresAt ? new Date(a.tlsExpiresAt) : null),
      render: (a) => (
        <span style={{ color: 'var(--muted)' }}>{fmtDate(a.tlsExpiresAt)}</span>
      ),
    },
  ];
}

function AlertStatus({ status }: { status: DomainAlert['status'] }) {
  switch (status) {
    case 'EXPIRING':
      return <Tag tone="warn">Expiring</Tag>;
    case 'EXPIRED':
      return <Tag tone="danger">Expired</Tag>;
    case 'FAIL':
      return <Tag tone="danger">Fail</Tag>;
    default:
      return <Tag tone="outline">{status}</Tag>;
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 10);
}
