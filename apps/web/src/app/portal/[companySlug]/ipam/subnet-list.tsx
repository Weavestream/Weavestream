'use client';

import Link from 'next/link';
import {
  DataTable,
  type DataColumn,
  MobileCardRow,
  Tag,
} from '../../../../components/ui';
import type { SubnetRow } from '../../../../lib/server-api';

/**
 * Portal-side subnet list. Read-only mirror of the admin browser's
 * top-level table — clicking a row navigates to the per-subnet detail
 * page within the same portal company scope.
 */
export function SubnetList({
  items,
  companySlug,
}: {
  items: SubnetRow[];
  companySlug: string;
}) {
  return (
    <DataTable
      columns={subnetColumns({ companySlug })}
      rows={items}
      renderMobileCard={(r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Link
              href={`/portal/${companySlug}/ipam/${r.id}`}
              style={{
                color: 'var(--accent)',
                fontWeight: 600,
                fontSize: 14,
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.name}
            </Link>
            {r.conflictCount > 0 && (
              <Tag tone="danger">
                {r.conflictCount} conflict{r.conflictCount > 1 ? 's' : ''}
              </Tag>
            )}
          </div>
          <MobileCardRow label="CIDR" mono>
            {r.cidr}
          </MobileCardRow>
          {r.vlanId != null && <MobileCardRow label="VLAN">{r.vlanId}</MobileCardRow>}
          <MobileCardRow label="Used">
            <UtilizationBar row={r} />
          </MobileCardRow>
        </div>
      )}
    />
  );
}

function subnetColumns({
  companySlug,
}: {
  companySlug: string;
}): DataColumn<SubnetRow>[] {
  return [
    {
      id: 'name',
      header: 'Name',
      width: 280,
      sortValue: (r) => r.name.toLowerCase(),
      render: (r) => (
        <span>
          <Link
            href={`/portal/${companySlug}/ipam/${r.id}`}
            style={{
              color: 'var(--accent)',
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            {r.name}
          </Link>
          {r.conflictCount > 0 && (
            <Tag tone="danger" style={{ marginLeft: 6 }}>
              {r.conflictCount} conflict{r.conflictCount > 1 ? 's' : ''}
            </Tag>
          )}
        </span>
      ),
    },
    {
      id: 'cidr',
      header: 'CIDR',
      width: 160,
      mono: true,
      sortValue: (r) => cidrSortValue(r.cidr),
      render: (r) => r.cidr,
    },
    {
      id: 'vlan',
      header: 'VLAN',
      width: 90,
      sortValue: (r) => r.vlanId ?? null,
      render: (r) => r.vlanId ?? '—',
    },
    {
      id: 'utilization',
      header: 'Utilization',
      sortValue: (r) =>
        r.utilization.totalUsable > 0
          ? r.utilization.claimed / r.utilization.totalUsable
          : 0,
      render: (r) => <UtilizationBar row={r} />,
    },
  ];
}

function UtilizationBar({ row }: { row: SubnetRow }) {
  const pct =
    row.utilization.totalUsable > 0
      ? Math.round((row.utilization.claimed / row.utilization.totalUsable) * 100)
      : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: 'var(--surface-2)',
          overflow: 'hidden',
          minWidth: 60,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            // keep non-zero usage visible even when it rounds to 0%
            minWidth: row.utilization.claimed > 0 ? 4 : undefined,
            height: '100%',
            borderRadius: 3,
            background:
              pct > 90
                ? 'var(--danger)'
                : pct > 70
                  ? 'var(--warning, orange)'
                  : 'var(--accent)',
          }}
        />
      </div>
      <span
        style={{
          fontSize: 12,
          color: 'var(--muted)',
          whiteSpace: 'nowrap',
        }}
      >
        {row.utilization.claimed}/{row.utilization.totalUsable}
      </span>
    </div>
  );
}

/**
 * Comparable representation of a CIDR string — combines the network
 * prefix (as a 32-bit integer) with the prefix length so subnets sort
 * by network first and then by mask length.
 */
function cidrSortValue(cidr: string): number {
  const [ip, len] = cidr.split('/');
  const parts = (ip ?? '').split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return 0;
  const ipInt =
    ((parts[0]! << 24) >>> 0) +
    ((parts[1]! << 16) >>> 0) +
    ((parts[2]! << 8) >>> 0) +
    (parts[3]! >>> 0);
  return ipInt * 64 + (Number(len) || 0);
}
