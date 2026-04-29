'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  DataTable,
  Icon,
  Input,
  MobileCardRow,
  Select,
  Tag,
  type DataColumn,
} from '../../../../components/ui';
import { membershipRoleLabel } from '../../../../lib/roles';
import { lower } from '../../../../lib/term';
import { useTerm } from '../../../../lib/term-context';
import type { MembershipRole } from '@weavestream/shared';

type Row = {
  id: string;
  role: MembershipRole;
  expiresAt: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string; role: string };
  company: { id: string; name: string; slug: string };
};

const ROLE_FILTERS = [
  { value: '', label: 'All roles' },
  { value: 'FULL', label: 'Full access' },
  { value: 'READONLY', label: 'Read-only' },
];

export function MembershipsTable({
  rows,
  filters,
}: {
  rows: Row[];
  filters: { q?: string; role?: string; expired?: string; expiringWithinDays?: string };
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [query, setQuery] = useState(filters.q ?? '');
  const term = useTerm();

  const columns = useMemo<DataColumn<Row>[]>(
    () => [
      {
        id: 'user',
        header: 'User',
        sortValue: (r) => r.user.name.toLowerCase(),
        render: (r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>{r.user.name}</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              {r.user.email}
            </span>
          </div>
        ),
      },
      {
        id: 'company',
        header: term.one,
        sortValue: (r) => r.company.name.toLowerCase(),
        render: (r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>{r.company.name}</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              /{r.company.slug}
            </span>
          </div>
        ),
      },
      {
        id: 'role',
        header: 'Role',
        width: 160,
        sortValue: (r) => r.role.toLowerCase(),
        render: (r) => <Tag tone="accent">{membershipRoleLabel(r.role)}</Tag>,
      },
      {
        id: 'expires',
        header: 'Expires',
        width: 160,
        mono: true,
        sortValue: (r) => (r.expiresAt ? new Date(r.expiresAt) : null),
        render: (r) => {
          if (!r.expiresAt) return <span style={{ color: 'var(--dim)' }}>never</span>;
          const ms = new Date(r.expiresAt).getTime() - Date.now();
          if (ms < 0) {
            return (
              <Tag tone="danger" dot>
                expired
              </Tag>
            );
          }
          const days = Math.ceil(ms / 86_400_000);
          const tone = days < 14 ? 'warn' : 'info';
          return (
            <Tag tone={tone} dot>
              in {days}d
            </Tag>
          );
        },
      },
    ],
    [term.one],
  );

  function setParams(mutate: (params: URLSearchParams) => void) {
    const next = new URLSearchParams(sp.toString());
    mutate(next);
    router.replace(`/admin/memberships?${next.toString()}`);
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: 10,
          borderBottom: '1px solid var(--line)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 320 }}>
          <span
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--dim)',
            }}
          >
            <Icon.search size={12} />
          </span>
          <Input
            placeholder={`Search users or ${lower(term.other)}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setParams((p) => {
                  if (query) p.set('q', query);
                  else p.delete('q');
                });
              }
            }}
            style={{ paddingLeft: 30, height: 28 }}
          />
        </div>
        <Select
          value={filters.role ?? ''}
          onChange={(e) =>
            setParams((p) => {
              if (e.target.value) p.set('role', e.target.value);
              else p.delete('role');
            })
          }
          style={{ width: 170, height: 28 }}
        >
          {ROLE_FILTERS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select
          value={
            filters.expired === '1'
              ? 'expired'
              : filters.expiringWithinDays ?? ''
          }
          onChange={(e) =>
            setParams((p) => {
              p.delete('expired');
              p.delete('expiringWithinDays');
              if (e.target.value === 'expired') p.set('expired', '1');
              else if (e.target.value) p.set('expiringWithinDays', e.target.value);
            })
          }
          style={{ width: 170, height: 28 }}
        >
          <option value="">Any expiration</option>
          <option value="14">Expiring ≤14d</option>
          <option value="30">Expiring ≤30d</option>
          <option value="expired">Already expired</option>
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        rowHref={(r) => `/admin/companies/${r.company.id}`}
        empty="No memberships match these filters."
        renderMobileCard={(r) => {
          let expiresNode: ReactNode = (
            <span style={{ color: 'var(--dim)' }}>never</span>
          );
          if (r.expiresAt) {
            const ms = new Date(r.expiresAt).getTime() - Date.now();
            if (ms < 0) {
              expiresNode = (
                <Tag tone="danger" dot>
                  expired
                </Tag>
              );
            } else {
              const days = Math.ceil(ms / 86_400_000);
              const tone = days < 14 ? 'warn' : 'info';
              expiresNode = (
                <Tag tone={tone} dot>
                  in {days}d
                </Tag>
              );
            }
          }
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div
                  style={{
                    color: 'var(--text)',
                    fontWeight: 600,
                    fontSize: 14,
                  }}
                >
                  {r.user.name}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    color: 'var(--dim)',
                    wordBreak: 'break-all',
                  }}
                >
                  {r.user.email}
                </div>
              </div>
              <MobileCardRow label={term.one}>
                <div>{r.company.name}</div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--dim)',
                  }}
                >
                  /{r.company.slug}
                </div>
              </MobileCardRow>
              <MobileCardRow label="Role">
                <Tag tone="accent">{membershipRoleLabel(r.role)}</Tag>
              </MobileCardRow>
              <MobileCardRow label="Expires" mono>
                {expiresNode}
              </MobileCardRow>
            </div>
          );
        }}
      />
    </div>
  );
}
