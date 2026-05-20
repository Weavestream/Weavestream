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
  inDhcp: boolean;
}

const PAGE_SIZE = 256;
const MAX_GRID_ADDRS = 1024;

export function AddressGrid({
  cidr,
  prefix,
  occupants,
  reservations,
  dhcpRangeStart,
  dhcpRangeEnd,
  companyId,
}: {
  cidr: string;
  prefix: number;
  occupants: SubnetOccupant[];
  reservations: IpReservationRow[];
  dhcpRangeStart: string | null;
  dhcpRangeEnd: string | null;
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

  const dhcpRange = useMemo<{ start: number; end: number } | null>(() => {
    if (!dhcpRangeStart || !dhcpRangeEnd) return null;
    const start = ipToInt(dhcpRangeStart);
    const end = ipToInt(dhcpRangeEnd);
    if (start > end) return null;
    return { start, end };
  }, [dhcpRangeStart, dhcpRangeEnd]);

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
    const addrInt = (networkInt + i) >>> 0;
    const ip = uint32ToIp(addrInt);
    const occ = occupantMap.get(ip) ?? [];
    const res = reservationMap.get(ip) ?? null;
    let state: CellState = 'free';
    if (hasNetworkBroadcast && i === 0) state = 'network';
    else if (hasNetworkBroadcast && i === lastIndex) state = 'broadcast';
    else if (occ.length > 1) state = 'conflict';
    else if (occ.length === 1) state = 'asset';
    else if (res) state = 'reservation';
    const inDhcp =
      !!dhcpRange &&
      state !== 'network' &&
      state !== 'broadcast' &&
      addrInt >= dhcpRange.start &&
      addrInt <= dhcpRange.end;
    cells.push({ ip, state, occupants: occ, reservation: res, inDhcp });
  }

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(40px, 1fr))',
          gap: 6,
          padding: 3, // Absorb the outer -3px margin of edge cells so they don't clip
          margin: '-3px 0 13px 0',
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
          marginTop: 16,
          display: 'flex',
          gap: 16,
          justifyContent: 'center',
          flexWrap: 'wrap',
          fontSize: 12,
          color: 'var(--muted)',
        }}
      >
        <LegendDot bg="var(--panel-2)" color="var(--muted)" label="Free" />
        <LegendDot
          bg="var(--ok)"
          color="var(--ok)"
          label="Taken"
        />
        <LegendDot
          bg="var(--danger)"
          color="var(--danger)"
          label="Conflict"
        />
        {prefix <= 30 && (
          <LegendDot bg="var(--panel-2)" color="var(--dim)" label="Network / broadcast" />
        )}
        {dhcpRange && <DhcpLegendSwatch />}
      </div>
    </div>
  );
}

function GridCell({ cell, companyId }: { cell: CellData; companyId: string }) {
  const [hover, setHover] = useState(false);

  // Solid, 100% opaque theme-aware colors
  const bg =
    cell.state === 'conflict'
      ? 'var(--danger)'
      : cell.state === 'asset' || cell.state === 'reservation'
        ? 'var(--ok)'
        : 'var(--panel-2)';

  const color =
    cell.state === 'conflict' || cell.state === 'asset' || cell.state === 'reservation'
      ? '#ffffff'
      : cell.state === 'network' || cell.state === 'broadcast'
        ? 'var(--dim)'
        : 'var(--muted)';

  const border = '1px solid transparent';

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
      style={{
        position: 'relative',
        background: cell.inDhcp ? 'color-mix(in srgb, var(--info) 18%, transparent)' : undefined,
        padding: 3,
        margin: -3,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          aspectRatio: '1 / 1',
          borderRadius: 6,
          background: bg,
          color: color,
          border: border,
          fontSize: 11,
          fontFamily: 'var(--font-mono, monospace)',
          fontWeight: cell.state !== 'free' && cell.state !== 'network' && cell.state !== 'broadcast' ? 600 : 400,
          cursor: cell.state === 'free' ? 'default' : 'pointer',
          textDecoration:
            cell.state === 'network' || cell.state === 'broadcast'
              ? 'line-through'
              : undefined,
          opacity:
            cell.state === 'network' || cell.state === 'broadcast' ? 0.5 : 1,
          boxSizing: 'border-box',
          transform: hover && cell.state !== 'free' ? 'scale(1.08)' : 'scale(1)',
          boxShadow: hover && cell.state !== 'free' ? '0 4px 12px rgba(0,0,0,0.15)' : 'none',
          transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)',
          zIndex: hover ? 2 : 1,
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
            boxShadow: '0 4px 12px rgba(0,0,0,.15)',
            marginBottom: 6,
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
          {cell.inDhcp && (
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              <Tag tone="outline" style={{ fontSize: 10 }}>
                DHCP
              </Tag>{' '}
              within dynamic range
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

function LegendDot({
  bg,
  color,
  border,
  label,
}: {
  bg: string;
  color: string;
  border?: string;
  label: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          background: bg,
          border: border || '1px solid transparent',
          display: 'inline-block',
        }}
      />
      <span style={{ color: color }}>{label}</span>
    </span>
  );
}

function DhcpLegendSwatch() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          background: 'color-mix(in srgb, var(--info) 18%, transparent)',
          border: '1px solid color-mix(in srgb, var(--info) 30%, transparent)',
          display: 'inline-block',
          boxSizing: 'border-box',
        }}
      />
      <span style={{ color: 'var(--info)' }}>DHCP range</span>
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
