'use client';

import {
  DataTable,
  type DataColumn,
  MobileCardRow,
  Tag,
} from '../../../../../../components/ui';
import type { DomainCheck } from '../../../../../../lib/server-api';
import {
  percentToTier,
  tierToLabel,
  tierToTone,
} from './score-card';
import { ScoreSparkline } from './score-sparkline';

/**
 * Append-only audit table of WHOIS / DNS / TLS check runs for a single
 * domain. Lives as a client component so we can use the shared
 * `DataTable` (sortable headers, sticky first column, mobile cards)
 * without forcing the surrounding server page to hydrate everything.
 */
export function DomainHistory({ checks }: { checks: DomainCheck[] }) {
  // v2 — render a sparkline of the most recent 30 scores at the top
  // of the panel so operators can see the trend before scrolling the
  // history table. Oldest-on-left, newest-on-right matches the table
  // sort default below.
  const scoresOldestFirst = [...checks]
    .sort(
      (a, b) =>
        new Date(a.checkedAt).getTime() - new Date(b.checkedAt).getTime(),
    )
    .map((c) => c.score);

  const columns: DataColumn<DomainCheck>[] = [
    {
      id: 'checkedAt',
      header: 'Checked',
      width: 200,
      mono: true,
      sortValue: (c) => new Date(c.checkedAt),
      render: (c) => fmtDateTime(c.checkedAt),
    },
    {
      id: 'score',
      header: 'Score',
      width: 120,
      sortValue: (c) => c.score ?? -1,
      render: (c) => <ScoreChip score={c.score} />,
    },
    {
      id: 'whois',
      header: 'WHOIS',
      width: 90,
      sortValue: (c) => statusRank(c.whoisStatus),
      render: (c) => <SubStatus status={c.whoisStatus} />,
    },
    {
      id: 'dns',
      header: 'DNS',
      width: 90,
      sortValue: (c) => statusRank(c.dnsStatus),
      render: (c) => <SubStatus status={c.dnsStatus} />,
    },
    {
      id: 'tls',
      header: 'TLS',
      width: 90,
      sortValue: (c) => statusRank(c.tlsStatus),
      render: (c) => <SubStatus status={c.tlsStatus} />,
    },
    {
      id: 'whoisExpiry',
      header: 'WHOIS expiry',
      width: 140,
      mono: true,
      sortValue: (c) => (c.whoisExpiresAt ? new Date(c.whoisExpiresAt) : null),
      render: (c) => (
        <span style={{ color: 'var(--muted)' }}>{fmtDate(c.whoisExpiresAt)}</span>
      ),
    },
    {
      id: 'tlsExpiry',
      header: 'TLS expiry',
      width: 140,
      mono: true,
      sortValue: (c) => (c.tlsExpiresAt ? new Date(c.tlsExpiresAt) : null),
      render: (c) => (
        <span style={{ color: 'var(--muted)' }}>{fmtDate(c.tlsExpiresAt)}</span>
      ),
    },
    {
      id: 'note',
      header: 'Note',
      sortable: false,
      render: (c) => (
        <span style={{ color: 'var(--muted)' }}>
          {c.error ?? summarize(c.details)}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {scoresOldestFirst.some((s) => typeof s === 'number') && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 14px',
            borderBottom: '1px solid var(--line)',
            fontSize: 12,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.3,
            }}
          >
            Trend
          </span>
          <ScoreSparkline scores={scoresOldestFirst} />
        </div>
      )}
      <DataTable
        columns={columns}
        rows={checks}
        defaultSort={{ columnId: 'checkedAt', direction: 'desc' }}
        renderMobileCard={(c) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: 'var(--dim)',
              }}
            >
              <span style={{ flex: 1 }}>{fmtDateTime(c.checkedAt)}</span>
              <ScoreChip score={c.score} />
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <SubLabel label="WHOIS" />
              <SubStatus status={c.whoisStatus} />
              <SubLabel label="DNS" />
              <SubStatus status={c.dnsStatus} />
              <SubLabel label="TLS" />
              <SubStatus status={c.tlsStatus} />
            </div>
            <MobileCardRow label="WHOIS" mono>
              {fmtDate(c.whoisExpiresAt)}
            </MobileCardRow>
            <MobileCardRow label="TLS" mono>
              {fmtDate(c.tlsExpiresAt)}
            </MobileCardRow>
            {(c.error || summarize(c.details)) && (
              <MobileCardRow label="Note">
                {c.error ?? summarize(c.details)}
              </MobileCardRow>
            )}
          </div>
        )}
      />
    </div>
  );
}

function ScoreChip({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <Tag tone="outline" mono>
        —
      </Tag>
    );
  }
  const tier = percentToTier(score);
  return (
    <Tag tone={tierToTone(tier)} mono>
      {score}% · {tierToLabel(tier)}
    </Tag>
  );
}

function SubLabel({ label }: { label: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        color: 'var(--dim)',
        marginRight: 2,
      }}
    >
      {label}
    </span>
  );
}

function SubStatus({ status }: { status: DomainCheck['whoisStatus'] }) {
  if (!status) return <Tag tone="outline">—</Tag>;
  switch (status) {
    case 'OK':
      return <Tag tone="ok">OK</Tag>;
    case 'WARN':
      return <Tag tone="warn">Warn</Tag>;
    case 'FAIL':
      return <Tag tone="danger">Fail</Tag>;
    case 'SKIP':
      return <Tag tone="outline">Skip</Tag>;
  }
}

function statusRank(status: DomainCheck['whoisStatus']): number {
  switch (status) {
    case 'OK':
      return 0;
    case 'WARN':
      return 1;
    case 'FAIL':
      return 2;
    case 'SKIP':
      return 3;
    default:
      return 4;
  }
}

function summarize(details: DomainCheck['details']): string {
  const parts: string[] = [];
  if (details.whois?.registrar) parts.push(`registrar=${details.whois.registrar}`);
  if (details.tls?.issuer) parts.push(`issuer=${details.tls.issuer}`);
  if (details.dns?.a && details.dns.a.length > 0) {
    parts.push(`A=${details.dns.a.length}`);
  }
  if (details.dns?.mx && details.dns.mx.length > 0) {
    parts.push(`MX=${details.dns.mx.length}`);
  }
  return parts.join(' · ');
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 10);
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}
