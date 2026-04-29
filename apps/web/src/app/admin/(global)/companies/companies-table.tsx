'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Btn,
  CompanyAvatar,
  DataTable,
  Icon,
  Input,
  MobileCardRow,
  StarButton,
  Tag,
  type DataColumn,
} from '../../../../components/ui';
import type { CompanyListItem } from '../../../../lib/server-api';
import {
  companyAccent,
  companyTypeLabel,
  companyTypeTone,
} from '../../../../lib/company-format';
import { lower } from '../../../../lib/term';
import { useTerm } from '../../../../lib/term-context';

export function CompaniesTable({
  rows,
  showArchived,
  q,
  canManage,
}: {
  rows: CompanyListItem[];
  showArchived: boolean;
  q: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [query, setQuery] = useState(q);
  const term = useTerm();

  const columns = useMemo<DataColumn<CompanyListItem>[]>(
    () => [
      {
        id: 'star',
        header: '',
        width: 48,
        align: 'center',
        sortValue: (r) => (r.isStarred ? 0 : 1),
        render: (r) => (
          <StarButton
            entityType="company"
            entityId={r.id}
            initialStarred={r.isStarred}
            iconSize={13}
          />
        ),
      },
      {
        id: 'name',
        header: term.one,
        sortValue: (r) => r.name.toLowerCase(),
        render: (r) => (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CompanyAvatar
              name={r.name}
              color={companyAccent(r.id)}
              logoUrl={r.logo?.thumbnailUrl ?? r.logo?.url ?? null}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ color: 'var(--text)', fontWeight: 500 }}>{r.name}</span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--dim)',
                }}
              >
                /{r.slug}
              </span>
            </div>
          </div>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        width: 120,
        sortValue: (r) => companyTypeLabel(r.type).toLowerCase(),
        render: (r) => (
          <Tag tone={companyTypeTone(r.type)} dot>
            {companyTypeLabel(r.type)}
          </Tag>
        ),
      },
      {
        id: 'location',
        header: 'Location',
        width: 180,
        sortValue: (r) =>
          [r.city, r.region, r.country].filter(Boolean).join(', ').toLowerCase() ||
          null,
        render: (r) => {
          const parts = [r.city, r.region, r.country].filter(Boolean);
          if (parts.length === 0) {
            return <span style={{ color: 'var(--dim)' }}>—</span>;
          }
          return (
            <span style={{ color: 'var(--text-2)', fontSize: 12.5 }}>
              {parts.join(', ')}
            </span>
          );
        },
      },
      {
        id: 'members',
        header: 'Members',
        mono: true,
        width: 100,
        sortValue: (r) => r.memberCount,
        render: (r) => <span>{r.memberCount}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        width: 120,
        sortValue: (r) => (r.archivedAt ? 1 : 0),
        render: (r) =>
          r.archivedAt ? (
            <Tag tone="warn" dot>
              archived
            </Tag>
          ) : (
            <Tag tone="ok" dot>
              active
            </Tag>
          ),
      },
      {
        id: 'created',
        header: 'Created',
        mono: true,
        width: 130,
        sortValue: (r) => new Date(r.createdAt),
        render: (r) => <span style={{ color: 'var(--dim)' }}>{relative(r.createdAt)}</span>,
      },
    ],
    [term.one],
  );

  function setParams(mutate: (params: URLSearchParams) => void) {
    const next = new URLSearchParams(sp.toString());
    mutate(next);
    router.replace(`/admin/companies?${next.toString()}`);
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
        }}
      >
        <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
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
            placeholder="Search by name or slug"
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
        <Btn
          kind={showArchived ? 'solid' : 'outline'}
          size="sm"
          icon={Icon.archive}
          onClick={() =>
            setParams((p) => {
              if (showArchived) p.delete('showArchived');
              else p.set('showArchived', '1');
            })
          }
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </Btn>
      </div>
      <DataTable
        columns={canManage ? columns : columns.filter((c) => c.id !== 'status')}
        rows={rows}
        rowHref={(r) => `/admin/companies/${r.id}`}
        empty={
          q
            ? `No ${lower(term.other)} match "${q}".`
            : `No ${lower(term.other)} yet.`
        }
        renderMobileCard={(r) => {
          const location = [r.city, r.region, r.country]
            .filter(Boolean)
            .join(', ');
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <CompanyAvatar
                  name={r.name}
                  color={companyAccent(r.id)}
                  logoUrl={r.logo?.thumbnailUrl ?? r.logo?.url ?? null}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: 'var(--text)',
                      fontWeight: 600,
                      fontSize: 14,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.name}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--dim)',
                    }}
                  >
                    /{r.slug}
                  </div>
                </div>
                <StarButton
                  entityType="company"
                  entityId={r.id}
                  initialStarred={r.isStarred}
                  iconSize={14}
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  alignItems: 'center',
                }}
              >
                <Tag tone={companyTypeTone(r.type)} dot>
                  {companyTypeLabel(r.type)}
                </Tag>
                {canManage &&
                  (r.archivedAt ? (
                    <Tag tone="warn" dot>
                      archived
                    </Tag>
                  ) : (
                    <Tag tone="ok" dot>
                      active
                    </Tag>
                  ))}
              </div>
              {location && (
                <MobileCardRow label="Location">{location}</MobileCardRow>
              )}
              <MobileCardRow label="Members" mono>
                {r.memberCount}
              </MobileCardRow>
              <MobileCardRow label="Created" mono>
                {relative(r.createdAt)}
              </MobileCardRow>
            </div>
          );
        }}
      />
    </div>
  );
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86_400_000;
  if (diff < day) return 'today';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
}
