'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import type { ExpirationRow } from '../../lib/server-api';
import {
  DataTable,
  Icon,
  LayoutSwatch,
  MobileCardRow,
  Tag,
  type DataColumn,
} from '../ui';
import {
  FormattedCalendarDate,
  FormattedDateTime,
} from '../../lib/timezone-context';

/**
 * Unified "Expiring soon" table. Rows come pre-sorted by the API
 * (most overdue first). The company column is only rendered in
 * cross-tenant mode so the scoped variant keeps a tighter layout and
 * doesn't repeat the already-visible tenant name on every row.
 *
 * On mobile we swap the table for the shared `DataTable` card layout
 * — same component the rest of the admin surfaces use — so each row
 * reads as a self-contained card with label/value pairs.
 */
export function ExpirationsTable({
  rows,
  showCompany,
}: {
  rows: ExpirationRow[];
  /**
   * Show the "Company" column. Set when rendering the global
   * cross-tenant feed; omit for the company-scoped view, where every
   * row belongs to the same tenant anyway.
   */
  showCompany: boolean;
}) {
  const dataRows = useMemo(
    () => rows.map((r) => ({ ...r, id: rowKey(r) })),
    [rows],
  );

  const columns = useMemo<DataColumn<(typeof dataRows)[number]>[]>(() => {
    const base: DataColumn<(typeof dataRows)[number]>[] = [
      {
        id: 'status',
        header: 'Status',
        width: 92,
        render: (row) => <StatusPill row={row} />,
      },
      {
        id: 'item',
        header: 'Item',
        render: (row) => <ItemCell row={row} />,
      },
      {
        id: 'source',
        header: 'Source',
        width: 160,
        render: (row) => <SourceCell row={row} />,
      },
    ];
    if (showCompany) {
      base.push({
        id: 'company',
        header: 'Company',
        width: 180,
        render: (row) => (
          <Link
            href={`/admin/companies/${row.companyId}`}
            style={{ color: 'var(--text)', fontWeight: 500 }}
          >
            {row.companyName}
          </Link>
        ),
      });
    }
    base.push({
      id: 'expires',
      header: 'Expires',
      width: 170,
      mono: true,
      render: (row) => (
        <span style={{ color: 'var(--text-2)' }}>
          <ExpiresValue row={row} />
        </span>
      ),
    });
    base.push({
      id: 'days',
      header: 'Days',
      width: 90,
      mono: true,
      render: (row) => (
        <span style={{ color: daysColor(row.daysUntil), fontWeight: 500 }}>
          {formatDays(row.daysUntil)}
        </span>
      ),
    });
    return base;
  }, [showCompany]);

  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 40,
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 13,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            background: 'var(--ok-soft)',
            color: 'var(--ok)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Icon.check size={18} stroke={2} />
        </div>
        <div>Nothing expiring in the next 30 days.</div>
      </div>
    );
  }

  return (
    <DataTable
      columns={columns}
      rows={dataRows}
      disableSort
      rowHref={(row) => detailHref(row)}
      renderMobileCard={(row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <ItemCell row={row} asLink={false} />
            <span style={{ marginLeft: 'auto' }}>
              <StatusPill row={row} />
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
            }}
          >
            <SourceCell row={row} />
            {showCompany && (
              <Tag tone="outline">{row.companyName}</Tag>
            )}
          </div>
          <MobileCardRow label="Expires" mono>
            <ExpiresValue row={row} />
          </MobileCardRow>
          <MobileCardRow label="Days" mono>
            <span style={{ color: daysColor(row.daysUntil), fontWeight: 500 }}>
              {formatDays(row.daysUntil)}
            </span>
          </MobileCardRow>
        </div>
      )}
    />
  );
}

function StatusPill({ row }: { row: ExpirationRow }) {
  if (row.status === 'EXPIRED') {
    return (
      <Tag tone="danger">
        Expired
      </Tag>
    );
  }
  const urgent = row.daysUntil <= 7;
  return (
    <Tag tone={urgent ? 'warn' : 'outline'}>
      {row.daysUntil === 0 ? 'Today' : `${row.daysUntil}d`}
    </Tag>
  );
}

function ItemCell({
  row,
  asLink = true,
}: {
  row: ExpirationRow;
  asLink?: boolean;
}) {
  const body =
    row.kind === 'asset-field' ? (
      <>
        <LayoutSwatch icon={row.layoutIcon} color={row.layoutColor} size={22} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 500,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.assetName}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.layoutName} · {row.fieldLabel}
          </div>
        </div>
      </>
    ) : row.kind === 'domain' ? (
      <>
        <div
          style={{
            width: 22,
            height: 22,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 5,
            background: 'var(--info-soft)',
            color: 'var(--info)',
            flexShrink: 0,
          }}
        >
          <Icon.globe size={13} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 500,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.hostname}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
            }}
          >
            Domain · {row.source === 'registrar' ? 'Registration' : 'TLS cert'}
          </div>
        </div>
      </>
    ) : (
      <>
        <div
          style={{
            width: 22,
            height: 22,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 5,
            background: 'var(--warn-soft)',
            color: 'var(--warn)',
            flexShrink: 0,
          }}
        >
          <Icon.lock size={13} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 500,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.passwordName}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
            }}
          >
            Vault · {row.source === 'expiry' ? 'Hard expiry' : 'Rotation due'}
          </div>
        </div>
      </>
    );

  const containerStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: 'inherit',
    minWidth: 0,
    flex: 1,
  } as const;

  if (!asLink) {
    return <div style={containerStyle}>{body}</div>;
  }
  return (
    <Link href={detailHref(row)} style={containerStyle}>
      {body}
    </Link>
  );
}

function SourceCell({ row }: { row: ExpirationRow }) {
  if (row.kind === 'asset-field') {
    return <Tag tone="outline">{row.fieldLabel}</Tag>;
  }
  if (row.kind === 'domain') {
    return (
      <Tag tone="outline">
        {row.source === 'registrar' ? 'Registrar' : 'TLS certificate'}
      </Tag>
    );
  }
  return (
    <Tag tone="outline">
      {row.source === 'expiry' ? 'Password expiry' : 'Password rotation'}
    </Tag>
  );
}

function detailHref(row: ExpirationRow): string {
  if (row.kind === 'asset-field') {
    return `/admin/companies/${row.companyId}/assets/${row.assetId}`;
  }
  if (row.kind === 'domain') {
    return `/admin/companies/${row.companyId}/domains/${row.domainId}`;
  }
  return `/admin/companies/${row.companyId}/passwords/${row.passwordId}`;
}

function expiresFormat(row: ExpirationRow): 'DATE' | 'DATETIME' {
  if (row.kind === 'asset-field') return row.fieldType;
  return 'DATETIME';
}

function daysColor(n: number): string {
  if (n < 0) return 'var(--danger)';
  if (n <= 7) return 'var(--warn)';
  return 'var(--text-2)';
}

function ExpiresValue({ row }: { row: ExpirationRow }) {
  // Calendar-day asset fields (DATE) render in UTC so the stored day
  // never shifts across zones; timestamps (domains, passwords, DATETIME
  // fields) render in the viewer's timezone.
  return expiresFormat(row) === 'DATE' ? (
    <FormattedCalendarDate value={row.expiresAt} />
  ) : (
    <FormattedDateTime value={row.expiresAt} />
  );
}

function formatDays(n: number): string {
  if (n === 0) return 'today';
  if (n > 0) return `in ${n}d`;
  return `${Math.abs(n)}d ago`;
}

function rowKey(row: ExpirationRow): string {
  if (row.kind === 'asset-field') {
    return `af:${row.assetId}:${row.fieldId}`;
  }
  if (row.kind === 'domain') {
    return `dm:${row.domainId}:${row.source}`;
  }
  return `pw:${row.passwordId}:${row.source}`;
}
