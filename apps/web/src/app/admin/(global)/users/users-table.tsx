'use client';

import { useMemo, useState } from 'react';
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
import { globalAccessLabel, roleLabel } from '../../../../lib/roles';
import type { UserListItem } from '../../../../lib/server-api';
import { shortRelative as relative } from '../../../../lib/relative-time';

const ROLE_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All roles' },
  { value: 'SUPER_ADMIN', label: 'super admin' },
  { value: 'OPERATOR', label: 'operator' },
  { value: 'CONTRACTOR', label: 'contractor' },
  { value: 'CLIENT_USER', label: 'client user' },
];

export function UsersTable({
  rows,
  filters,
  canManage,
}: {
  rows: UserListItem[];
  filters: { q?: string; role?: string; isActive?: string };
  canManage: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [query, setQuery] = useState(filters.q ?? '');

  const columns = useMemo<DataColumn<UserListItem>[]>(
    () => [
      {
        id: 'name',
        header: 'User',
        sortValue: (r) => r.name.toLowerCase(),
        render: (r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>{r.name}</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              {r.email}
            </span>
          </div>
        ),
      },
      {
        id: 'role',
        header: 'Role',
        width: 220,
        sortValue: (r) => roleLabel(r.role).toLowerCase(),
        render: (r) => (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <Tag tone="accent">{roleLabel(r.role)}</Tag>
            {r.role === 'OPERATOR' && r.globalAccess ? (
              <Tag tone={r.globalAccess === 'NONE' ? 'warn' : 'outline'}>
                {globalAccessLabel(r.globalAccess)}
              </Tag>
            ) : null}
            {r.role === 'OPERATOR' && r.platformCapabilities.length > 0 ? (
              <Tag tone="info">
                +{r.platformCapabilities.length} caps
              </Tag>
            ) : null}
          </div>
        ),
      },
      {
        id: 'mfa',
        header: 'MFA',
        width: 90,
        sortValue: (r) => (r.mfaEnabled ? 1 : 0),
        render: (r) =>
          r.mfaEnabled ? (
            <Tag tone="ok">
              on
            </Tag>
          ) : (
            <Tag tone="warn">
              off
            </Tag>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        width: 120,
        sortValue: (r) => (r.isActive ? 1 : 0),
        render: (r) =>
          r.isActive ? (
            <Tag tone="ok">
              active
            </Tag>
          ) : (
            <Tag tone="warn">
              inactive
            </Tag>
          ),
      },
      {
        id: 'last',
        header: 'Last login',
        width: 150,
        mono: true,
        sortValue: (r) => (r.lastLoginAt ? new Date(r.lastLoginAt) : null),
        render: (r) => (
          <span style={{ color: 'var(--dim)' }}>
            {r.lastLoginAt ? relative(r.lastLoginAt) : 'never'}
          </span>
        ),
      },
    ],
    [],
  );

  function setParams(mutate: (params: URLSearchParams) => void) {
    const next = new URLSearchParams(sp.toString());
    mutate(next);
    router.replace(`/admin/users?${next.toString()}`);
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
            placeholder="Search by name or email"
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
          value={filters.isActive ?? ''}
          onChange={(e) =>
            setParams((p) => {
              if (e.target.value) p.set('isActive', e.target.value);
              else p.delete('isActive');
            })
          }
          style={{ width: 130, height: 28 }}
        >
          <option value="">Any status</option>
          <option value="true">Active only</option>
          <option value="false">Inactive only</option>
        </Select>
      </div>
      <DataTable
        columns={canManage ? columns : columns}
        rows={rows}
        rowHref={(r) => `/admin/users/${r.id}`}
        empty={filters.q ? `No users match "${filters.q}".` : 'No users yet.'}
        renderMobileCard={(r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span
                style={{ color: 'var(--text)', fontWeight: 600, fontSize: 14 }}
              >
                {r.name}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--dim)',
                  wordBreak: 'break-all',
                }}
              >
                {r.email}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Tag tone="accent">{roleLabel(r.role)}</Tag>
              {r.role === 'OPERATOR' && r.globalAccess ? (
                <Tag tone={r.globalAccess === 'NONE' ? 'warn' : 'outline'}>
                  {globalAccessLabel(r.globalAccess)}
                </Tag>
              ) : null}
              {r.role === 'OPERATOR' && r.platformCapabilities.length > 0 ? (
                <Tag tone="info">
                  +{r.platformCapabilities.length} caps
                </Tag>
              ) : null}
              {r.mfaEnabled ? (
                <Tag tone="ok">
                  mfa on
                </Tag>
              ) : (
                <Tag tone="warn">
                  mfa off
                </Tag>
              )}
              {r.isActive ? (
                <Tag tone="ok">
                  active
                </Tag>
              ) : (
                <Tag tone="warn">
                  inactive
                </Tag>
              )}
            </div>
            <MobileCardRow label="Last login" mono>
              {r.lastLoginAt ? relative(r.lastLoginAt) : 'never'}
            </MobileCardRow>
          </div>
        )}
      />
    </div>
  );
}
