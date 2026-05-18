'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  DataTable,
  type DataColumn,
  MobileCardRow,
  Panel,
  Tag,
  type TagTone,
} from '../../../components/ui';
import type { DomainAlert } from '../../../lib/server-api';

type ScoreFilter = 'all' | 'lt55' | 'lt35';

/**
 * Cross-company domain alerts — surfaces EXPIRING / EXPIRED / FAIL
 * domains AND low-score domains (v2) on the global dashboard so
 * SUPER_ADMIN sees trouble at a glance. Filter chips let operators
 * narrow the feed to critical/poor score buckets.
 */
export function DomainAlertsPanel({ alerts }: { alerts: DomainAlert[] }) {
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>('all');

  const filtered = useMemo(() => {
    if (scoreFilter === 'all') return alerts;
    const ceiling = scoreFilter === 'lt35' ? 35 : 55;
    return alerts.filter(
      (a) => typeof a.latestScore === 'number' && a.latestScore < ceiling,
    );
  }, [alerts, scoreFilter]);

  return (
    <Panel
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          Domain alerts
          {filtered.length > 0 && (
            <Tag tone="danger">
              {filtered.length}
            </Tag>
          )}
        </span>
      }
      actions={
        <div style={{ display: 'inline-flex', gap: 4 }}>
          <FilterChip
            active={scoreFilter === 'all'}
            onClick={() => setScoreFilter('all')}
          >
            All
          </FilterChip>
          <FilterChip
            active={scoreFilter === 'lt55'}
            onClick={() => setScoreFilter('lt55')}
          >
            &lt; 55% poor
          </FilterChip>
          <FilterChip
            active={scoreFilter === 'lt35'}
            onClick={() => setScoreFilter('lt35')}
          >
            &lt; 35% critical
          </FilterChip>
        </div>
      }
      noPad
    >
      {filtered.length === 0 ? (
        <div
          style={{
            padding: 24,
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          {alerts.length === 0
            ? 'All monitored domains are healthy.'
            : 'No domains match the selected filter.'}
        </div>
      ) : (
        <DataTable
          columns={alertColumns()}
          rows={filtered.map((a) => ({ ...a, id: a.domainId }))}
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
                <ScoreChip score={a.latestScore} />
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

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '3px 8px',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
        border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`,
        borderRadius: 4,
        cursor: 'pointer',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {children}
    </button>
  );
}

function scoreToTone(score: number): TagTone {
  if (score >= 90) return 'ok';
  if (score >= 75) return 'ok';
  if (score >= 55) return 'warn';
  return 'danger';
}

function ScoreChip({ score }: { score: number | null }) {
  if (score === null) {
    return <Tag tone="outline">—</Tag>;
  }
  return <Tag tone={scoreToTone(score)}>{score}%</Tag>;
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
      id: 'score',
      header: 'Score',
      width: 90,
      sortValue: (a) => a.latestScore ?? -1,
      render: (a) => <ScoreChip score={a.latestScore} />,
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
