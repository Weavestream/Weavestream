'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type {
  SubnetOccupant,
  IpReservationRow,
} from '../../../../../lib/server-api';
import {
  Btn,
  DataTable,
  type DataColumn,
  Tag,
} from '../../../../../components/ui';

type CellState =
  | 'free'
  | 'asset'
  | 'reservation'
  | 'conflict'
  | 'network'
  | 'broadcast';

interface CellData {
  ip: string;
  state: CellState;
  occupants: SubnetOccupant[];
  reservation: IpReservationRow | null;
}

const PAGE_SIZE = 256;
const MAX_GRID_ADDRS = 1024;

export function AddressGrid({
  cidr,
  prefix,
  occupants,
  reservations,
  companyId,
}: {
  cidr: string;
  prefix: number;
  occupants: SubnetOccupant[];
  reservations: IpReservationRow[];
  companyId: string;
}) {
  const totalAddrs = Math.pow(2, 32 - prefix);

  const occupantMap = useMemo(() => {
    const m = new Map<string, SubnetOccupant[]>();
    for (const o of occupants) {
      const arr = m.get(o.ip) ?? [];
      arr.push(o);
      m.set(o.ip, arr);
    }
    return m;
  }, [occupants]);

  const reservationMap = useMemo(() => {
    const m = new Map<string, IpReservationRow>();
    for (const r of reservations) m.set(r.ipAddress, r);
    return m;
  }, [reservations]);

  const networkInt = useMemo(() => cidrToNetworkInt(cidr), [cidr]);

  const [page, setPage] = useState(0);

  // For very large subnets, fall back to a compact list of assigned IPs only
  if (totalAddrs > MAX_GRID_ADDRS) {
    return (
      <CompactList
        occupantMap={occupantMap}
        reservationMap={reservationMap}
        companyId={companyId}
      />
    );
  }

  const pageCount = Math.ceil(totalAddrs / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, totalAddrs);

  // /31 (point-to-point) and /32 (host route) have no network/broadcast
  // reservation; every address is host-usable.
  const hasNetworkBroadcast = prefix <= 30;
  const lastIndex = totalAddrs - 1;

  const cells: CellData[] = [];
  for (let i = start; i < end; i++) {
    const ip = uint32ToIp((networkInt + i) >>> 0);
    const occ = occupantMap.get(ip) ?? [];
    const res = reservationMap.get(ip) ?? null;
    let state: CellState = 'free';
    if (hasNetworkBroadcast && i === 0) state = 'network';
    else if (hasNetworkBroadcast && i === lastIndex) state = 'broadcast';
    else if (occ.length > 1) state = 'conflict';
    else if (occ.length === 1) state = 'asset';
    else if (res) state = 'reservation';
    cells.push({ ip, state, occupants: occ, reservation: res });
  }

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
          gap: 4,
        }}
      >
        {cells.map((cell) => (
          <GridCell key={cell.ip} cell={cell} companyId={companyId} />
        ))}
      </div>
      {pageCount > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 8,
            marginTop: 12,
            alignItems: 'center',
          }}
        >
          <Btn
            size="sm"
            kind="ghost"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Prev
          </Btn>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Page {page + 1} of {pageCount}
          </span>
          <Btn
            size="sm"
            kind="ghost"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </Btn>
        </div>
      )}
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          fontSize: 12,
          color: 'var(--muted)',
        }}
      >
        <LegendDot color="var(--surface-2)" label="Free" />
        <LegendDot color="var(--accent)" label="Asset" />
        <LegendDot color="var(--info, #3b82f6)" label="Reservation" />
        <LegendDot color="var(--danger)" label="Conflict" />
        {prefix <= 30 && (
          <LegendDot color="var(--panel-2)" label="Network / broadcast" />
        )}
      </div>
    </div>
  );
}

function GridCell({ cell, companyId }: { cell: CellData; companyId: string }) {
  const [hover, setHover] = useState(false);
  const bg =
    cell.state === 'conflict'
      ? 'var(--danger)'
      : cell.state === 'asset'
        ? 'var(--accent)'
        : cell.state === 'reservation'
          ? 'var(--info, #3b82f6)'
          : cell.state === 'network' || cell.state === 'broadcast'
            ? 'var(--panel-2)'
            : 'var(--surface-2)';

  const reservedLabel =
    cell.state === 'network'
      ? 'Network address'
      : cell.state === 'broadcast'
        ? 'Broadcast address'
        : null;

  const label =
    cell.occupants.length > 0
      ? cell.occupants.map((o) => o.assetName).join(', ')
      : cell.reservation
        ? cell.reservation.label
        : reservedLabel;

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          padding: '4px 6px',
          borderRadius: 4,
          background: bg,
          color:
            cell.state === 'free'
              ? 'var(--muted)'
              : cell.state === 'network' || cell.state === 'broadcast'
                ? 'var(--dim)'
                : 'var(--on-accent, #fff)',
          fontSize: 11,
          fontFamily: 'var(--font-mono, monospace)',
          textAlign: 'center',
          cursor: cell.state === 'free' ? 'default' : 'pointer',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textDecoration:
            cell.state === 'network' || cell.state === 'broadcast'
              ? 'line-through'
              : undefined,
          opacity:
            cell.state === 'network' || cell.state === 'broadcast' ? 0.7 : 1,
        }}
      >
        {cell.ip.split('.').pop()}
      </div>
      {hover && label && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            whiteSpace: 'nowrap',
            zIndex: 10,
            boxShadow: '0 2px 8px rgba(0,0,0,.15)',
            marginBottom: 4,
          }}
        >
          <div style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
            {cell.ip}
          </div>
          {cell.occupants.map((o, i) => (
            <div key={i}>
              <Link
                href={`/admin/companies/${companyId}/assets/${o.assetId}`}
                style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 11 }}
              >
                {o.assetName}
              </Link>
              <span style={{ color: 'var(--muted)', fontSize: 11 }}> ({o.fieldName})</span>
            </div>
          ))}
          {cell.reservation && (
            <div style={{ fontSize: 11 }}>
              <Tag tone="outline" style={{ fontSize: 10 }}>reserved</Tag> {cell.reservation.label}
            </div>
          )}
          {(cell.state === 'network' || cell.state === 'broadcast') && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              <Tag tone="outline" style={{ fontSize: 10 }}>
                {cell.state}
              </Tag>{' '}
              not assignable
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CompactList({
  occupantMap,
  reservationMap,
  companyId,
}: {
  occupantMap: Map<string, SubnetOccupant[]>;
  reservationMap: Map<string, IpReservationRow>;
  companyId: string;
}) {
  const allIps = Array.from(
    new Set([...occupantMap.keys(), ...reservationMap.keys()]),
  ).sort(compareIp);

  if (allIps.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
        No assigned addresses in this range.
      </div>
    );
  }

  type Row = {
    id: string;
    ip: string;
    occupants: SubnetOccupant[];
    reservation: IpReservationRow | null;
  };
  const rows: Row[] = allIps.map((ip) => ({
    id: ip,
    ip,
    occupants: occupantMap.get(ip) ?? [],
    reservation: reservationMap.get(ip) ?? null,
  }));

  const columns: DataColumn<Row>[] = [
    {
      id: 'ip',
      header: 'IP',
      width: 200,
      mono: true,
      sortValue: (r) => ipToInt(r.ip),
      render: (r) => (
        <span>
          {r.ip}
          {r.occupants.length > 1 && (
            <Tag tone="danger" style={{ marginLeft: 6, fontSize: 11 }}>
              conflict
            </Tag>
          )}
        </span>
      ),
    },
    {
      id: 'occupant',
      header: 'Occupant',
      sortValue: (r) =>
        r.occupants[0]?.assetName?.toLowerCase() ??
        r.reservation?.label?.toLowerCase() ??
        null,
      render: (r) => (
        <span>
          {r.occupants.map((o, i) => (
            <span key={i}>
              {i > 0 && ', '}
              <Link
                href={`/admin/companies/${companyId}/assets/${o.assetId}`}
                style={{ color: 'var(--accent)', textDecoration: 'none' }}
              >
                {o.assetName}
              </Link>
            </span>
          ))}
          {r.reservation && !r.occupants.length && r.reservation.label}
        </span>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      width: 120,
      sortValue: (r) =>
        r.occupants.length > 0 ? 'asset' : r.reservation ? 'reserved' : '',
      render: (r) =>
        r.occupants.length > 0 ? (
          <Tag tone="accent" style={{ fontSize: 11 }}>
            asset
          </Tag>
        ) : r.reservation ? (
          <Tag tone="outline" style={{ fontSize: 11 }}>
            reserved
          </Tag>
        ) : null,
    },
  ];

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
        Showing {allIps.length} assigned addresses (subnet too large for full grid view)
      </div>
      <DataTable columns={columns} rows={rows} />
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return 0;
  return (
    ((parts[0]! << 24) >>> 0) +
    ((parts[1]! << 16) >>> 0) +
    ((parts[2]! << 8) >>> 0) +
    (parts[3]! >>> 0)
  );
}

// ---------------------------------------------------------------------------
// IP helpers
// ---------------------------------------------------------------------------

function cidrToNetworkInt(cidr: string): number {
  const [host, pfx] = cidr.split('/');
  const parts = host!.split('.').map(Number);
  const ip = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  const mask = Number(pfx) === 0 ? 0 : (0xffffffff << (32 - Number(pfx))) >>> 0;
  return (ip & mask) >>> 0;
}

function uint32ToIp(n: number): string {
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

function compareIp(a: string, b: string): number {
  const ap = a.split('.').map(Number);
  const bp = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    if (ap[i]! !== bp[i]!) return ap[i]! - bp[i]!;
  }
  return 0;
}
