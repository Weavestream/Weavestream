'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  AssetSummary,
  LayoutSummary,
} from '../../../../../lib/server-api';
import { Icon, LayoutSwatch, Tag } from '../../../../../components/ui';
import { useIsMobile } from '../../../../../lib/hooks/use-is-mobile';

/**
 * Interactive asset list. URL is the source of truth; every filter
 * change pushes a new query string so deep links survive refreshes.
 * Field-level filters use the same `field.<slug>=<value>` DSL the API
 * accepts, rendered as removable chips.
 */
export function AssetsTable({
  companyId,
  rows,
  layouts,
  q,
  layoutId,
  includeArchived,
  fieldFilters,
  canManage: _canManage,
}: {
  companyId: string;
  rows: AssetSummary[];
  layouts: LayoutSummary[];
  q: string;
  layoutId: string;
  includeArchived: boolean;
  fieldFilters: Record<string, string>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [_pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(q);
  const isMobile = useIsMobile();

  const activeLayout = useMemo(
    () => layouts.find((l) => l.id === layoutId) ?? null,
    [layouts, layoutId],
  );

  function pushParams(next: Record<string, string | undefined | null>) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (layoutId) params.set('layout', layoutId);
    if (includeArchived) params.set('archived', '1');
    for (const [k, v] of Object.entries(fieldFilters)) params.set(`field.${k}`, v);
    for (const [k, v] of Object.entries(next)) {
      if (v == null || v === '') params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(
        `/admin/companies/${companyId}/assets${qs ? `?${qs}` : ''}`,
      );
    });
  }

  function removeFieldFilter(slug: string) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (layoutId) params.set('layout', layoutId);
    if (includeArchived) params.set('archived', '1');
    for (const [k, v] of Object.entries(fieldFilters)) {
      if (k === slug) continue;
      params.set(`field.${k}`, v);
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(
        `/admin/companies/${companyId}/assets${qs ? `?${qs}` : ''}`,
      );
    });
  }

  function clearAll() {
    startTransition(() => {
      router.push(`/admin/companies/${companyId}/assets`);
    });
  }

  function commitSearch() {
    pushParams({ q: draft.trim() || null });
  }

  return (
    <div>
      {/* Filter bar */}
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 180,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 28,
            padding: '0 10px',
            background: 'var(--panel-2)',
            border: '1px solid var(--line)',
            borderRadius: 5,
          }}
        >
          <Icon.search size={12} style={{ color: 'var(--muted)' }} />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSearch();
            }}
            onBlur={commitSearch}
            placeholder="Search by name…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 12.5,
              color: 'var(--text)',
            }}
          />
          <span
            style={{
              width: 1,
              height: 14,
              background: 'var(--line-2)',
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--muted)',
            }}
          >
            {rows.length} results
          </span>
        </div>

        <select
          value={layoutId}
          onChange={(e) => pushParams({ layout: e.target.value || null })}
          style={{
            height: 28,
            padding: '0 8px',
            background: 'var(--panel-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 5,
            fontSize: 12,
            color: 'var(--text)',
          }}
        >
          <option value="">All layouts</option>
          {layouts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => pushParams({ archived: includeArchived ? null : '1' })}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 10px',
            background: includeArchived ? 'var(--panel-2)' : 'transparent',
            border: '1px solid var(--line-2)',
            borderRadius: 5,
            fontSize: 12,
            color: 'var(--text-2)',
            cursor: 'pointer',
          }}
        >
          <Icon.archive size={12} />
          {includeArchived ? 'Hide archived' : 'Show archived'}
        </button>
      </div>

      {/* Chips row */}
      {(layoutId || Object.keys(fieldFilters).length > 0 || q) && (
        <div
          style={{
            padding: '8px 14px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
            background: 'var(--surface)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              marginRight: 6,
            }}
          >
            filters
          </span>
          {q && (
            <Chip onRemove={() => pushParams({ q: null })}>
              query: {q}
            </Chip>
          )}
          {activeLayout && (
            <Chip onRemove={() => pushParams({ layout: null })}>
              layout: {activeLayout.name}
            </Chip>
          )}
          {Object.entries(fieldFilters).map(([k, v]) => (
            <Chip key={k} onRemove={() => removeFieldFilter(k)}>
              {k}: {v}
            </Chip>
          ))}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={clearAll}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            clear all
          </button>
        </div>
      )}

      {/* Table / cards */}
      {rows.length === 0 ? (
        <div
          style={{
            padding: 36,
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          No assets match the current filters.
        </div>
      ) : isMobile ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {rows.map((r) => (
            <AssetMobileCard key={r.id} row={r} companyId={companyId} />
          ))}
        </ul>
      ) : (
        <div style={{ overflow: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12.5,
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                {['Name', 'Layout', 'Primary field', 'Source', 'Updated', ''].map(
                  (h, i) => (
                    <th
                      key={`${h}-${i}`}
                      style={{
                        textAlign: 'left',
                        padding: '8px 12px',
                        fontSize: 10,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--muted)',
                        fontWeight: 400,
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                      }}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <AssetRow
                  key={r.id}
                  row={r}
                  companyId={companyId}
                  isLast={i === rows.length - 1}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AssetMobileCard({
  row,
  companyId,
}: {
  row: AssetSummary;
  companyId: string;
}) {
  const primary = row.fields.find((f) => f.isPrimary);
  const primaryValue =
    primary && primary.slug in row.fieldValues
      ? renderScalar(
          row.fieldValues[primary.slug],
          primary.fieldType,
          row.references,
        )
      : null;
  return (
    <li
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        background: 'var(--panel)',
        opacity: row.archivedAt ? 0.7 : 1,
      }}
    >
      <Link
        href={`/admin/companies/${companyId}/assets/${row.id}`}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 12,
          color: 'inherit',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <LayoutSwatch icon={row.layoutIcon} color={row.layoutColor} size={24} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: 14,
                color: 'var(--text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.name}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              {row.layoutName}
            </div>
          </div>
          <Icon.chevron size={12} style={{ color: 'var(--dim)' }} />
        </div>
        {primaryValue && primaryValue !== '—' && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              color: 'var(--text-2)',
              wordBreak: 'break-word',
            }}
          >
            {primaryValue}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
          }}
        >
          {row.externalSource ? (
            <Tag tone="info">{row.externalSource.toLowerCase()}</Tag>
          ) : (
            <Tag tone="outline">manual</Tag>
          )}
          {row.archivedAt && <Tag tone="warn">archived</Tag>}
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--dim)',
            }}
          >
            {relative(new Date(row.updatedAt))}
          </span>
        </div>
      </Link>
    </li>
  );
}

function AssetRow({
  row,
  companyId,
  isLast,
}: {
  row: AssetSummary;
  companyId: string;
  isLast: boolean;
}) {
  const primary = row.fields.find((f) => f.isPrimary);
  const primaryValue =
    primary && primary.slug in row.fieldValues
      ? renderScalar(
          row.fieldValues[primary.slug],
          primary.fieldType,
          row.references,
        )
      : '—';
  const updated = new Date(row.updatedAt);

  return (
    <tr
      style={{
        borderBottom: isLast ? 'none' : '1px solid var(--line)',
        height: 44,
        opacity: row.archivedAt ? 0.55 : 1,
      }}
    >
      <td style={{ padding: '0 12px' }}>
        <Link
          href={`/admin/companies/${companyId}/assets/${row.id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'inherit',
          }}
        >
          <LayoutSwatch icon={row.layoutIcon} color={row.layoutColor} size={22} />
          <div style={{ fontWeight: 500 }}>
            {row.name}
            {row.archivedAt && (
              <Tag tone="warn" style={{ marginLeft: 8 }}>
                archived
              </Tag>
            )}
          </div>
        </Link>
      </td>
      <td style={{ padding: '0 12px', color: 'var(--muted)' }}>
        {row.layoutName}
      </td>
      <td
        style={{
          padding: '0 12px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--text-2)',
          maxWidth: 260,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {primaryValue}
      </td>
      <td style={{ padding: '0 12px' }}>
        {row.externalSource ? (
          <Tag tone="info">{row.externalSource.toLowerCase()}</Tag>
        ) : (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--dim)',
            }}
          >
            manual
          </span>
        )}
      </td>
      <td
        style={{
          padding: '0 12px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--dim)',
        }}
      >
        {relative(updated)}
      </td>
      <td style={{ padding: '0 12px', textAlign: 'right' }}>
        <Link
          href={`/admin/companies/${companyId}/assets/${row.id}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11.5,
            color: 'var(--accent)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          open
          <Icon.chevron size={10} />
        </Link>
      </td>
    </tr>
  );
}

function Chip({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 6px 2px 8px',
        background: 'var(--accent-soft)',
        color: 'var(--accent)',
        border: '1px solid var(--accent-line)',
        borderRadius: 3,
        fontSize: 10.5,
        fontFamily: 'var(--font-mono)',
      }}
    >
      {children}
      <button
        type="button"
        onClick={onRemove}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          padding: 0,
          display: 'grid',
          placeItems: 'center',
        }}
        aria-label="Remove filter"
      >
        <Icon.x size={9} />
      </button>
    </span>
  );
}

function renderScalar(
  value: unknown,
  fieldType?: AssetSummary['fields'][number]['fieldType'],
  references?: AssetSummary['references'],
): string {
  if (value == null) return '—';
  if (fieldType === 'ASSET_REFERENCE' && references) {
    const ids = Array.isArray(value) ? value : [value];
    return ids
      .map((v) => {
        const id = String(v);
        const hit = references[id];
        return hit?.name ?? `${id.slice(0, 8)}… (missing)`;
      })
      .join(', ');
  }
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function relative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const day = 86_400_000;
  if (diff < day) return 'today';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
}
