'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  AssetSummary,
  LayoutSummary,
} from '../../../../../lib/server-api';
import {
  DataTable,
  type DataColumn,
  Icon,
  LayoutSwatch,
  MobileCardRow,
  Tag,
} from '../../../../../components/ui';
import { vaultLinkLabel } from '../../../../../lib/vault-link';
import { TagFilterMenu } from '../../../../../components/layouts/tag-filter-menu';

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
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const activeLayout = useMemo(
    () => layouts.find((l) => l.id === layoutId) ?? null,
    [layouts, layoutId],
  );

  // Walk every loaded row's `fields` to find which slugs hold TAGS values.
  // Unlike `LayoutAssetsTable` this surface is multi-layout, so the set of
  // TAGS slugs varies row-by-row. We index per-row to avoid re-walking on
  // each filter pass.
  const rowTagIndex = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const r of rows) {
      const ids = new Set<string>();
      for (const f of r.fields) {
        if (f.fieldType !== 'TAGS') continue;
        const v = r.fieldValues[f.slug];
        if (!Array.isArray(v)) continue;
        for (const entry of v as unknown[]) {
          if (
            entry &&
            typeof entry === 'object' &&
            typeof (entry as { id?: unknown }).id === 'string'
          ) {
            ids.add((entry as { id: string }).id);
          }
        }
      }
      out.set(r.id, ids);
    }
    return out;
  }, [rows]);

  // Distinct `{id, name}` chips referenced across the current row set.
  // The server hydrates TAGS values into chip objects, so we just walk
  // them. Sort alphabetically for stable ordering.
  const availableTags = useMemo(() => {
    const byId = new Map<string, string>();
    for (const r of rows) {
      for (const f of r.fields) {
        if (f.fieldType !== 'TAGS') continue;
        const v = r.fieldValues[f.slug];
        if (!Array.isArray(v)) continue;
        for (const entry of v as unknown[]) {
          if (
            entry &&
            typeof entry === 'object' &&
            typeof (entry as { id?: unknown }).id === 'string' &&
            typeof (entry as { name?: unknown }).name === 'string'
          ) {
            const obj = entry as { id: string; name: string };
            if (!byId.has(obj.id)) byId.set(obj.id, obj.name);
          }
        }
      }
    }
    return Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  // Drop the tagFilter selection if the underlying tag list no longer
  // contains it (e.g. server-side filters narrowed the rows past every
  // reference to it).
  useEffect(() => {
    if (tagFilter && !availableTags.some((t) => t.id === tagFilter)) {
      setTagFilter(null);
    }
  }, [availableTags, tagFilter]);

  const visibleRows = useMemo(() => {
    if (!tagFilter) return rows;
    return rows.filter((r) => rowTagIndex.get(r.id)?.has(tagFilter));
  }, [rows, rowTagIndex, tagFilter]);

  const activeTag = tagFilter
    ? availableTags.find((t) => t.id === tagFilter) ?? null
    : null;

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
              whiteSpace: 'nowrap',
            }}
          >
            {visibleRows.length === rows.length
              ? `${rows.length} results`
              : `${visibleRows.length} of ${rows.length}`}
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

        {availableTags.length > 0 && (
          <TagFilterMenu
            tags={availableTags}
            value={tagFilter}
            activeName={activeTag?.name ?? null}
            onChange={setTagFilter}
          />
        )}

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
      {visibleRows.length === 0 ? (
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
      ) : (
        <DataTable
          columns={assetColumns({ companyId })}
          rows={visibleRows}
          renderMobileCard={(r) => <AssetMobileBody row={r} companyId={companyId} />}
        />
      )}
    </div>
  );
}

function assetColumns({
  companyId,
}: {
  companyId: string;
}): DataColumn<AssetSummary>[] {
  return [
    {
      id: 'name',
      header: 'Name',
      width: 320,
      sortValue: (r) => r.name.toLowerCase(),
      render: (r) => (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            opacity: r.archivedAt ? 0.55 : 1,
          }}
        >
          <LayoutSwatch icon={r.layoutIcon} color={r.layoutColor} size={22} />
          <Link
            href={`/admin/companies/${companyId}/assets/${r.id}`}
            style={{ color: 'inherit', fontWeight: 500 }}
          >
            {r.name}
            {r.archivedAt && (
              <Tag tone="warn" style={{ marginLeft: 8 }}>
                archived
              </Tag>
            )}
          </Link>
        </span>
      ),
    },
    {
      id: 'layout',
      header: 'Layout',
      width: 180,
      sortValue: (r) => r.layoutName.toLowerCase(),
      render: (r) => <span style={{ color: 'var(--muted)' }}>{r.layoutName}</span>,
    },
    {
      id: 'primary',
      header: 'Primary field',
      width: 280,
      sortValue: (r) => primaryString(r).toLowerCase(),
      render: (r) => (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--text-2)',
            display: 'inline-block',
            maxWidth: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            verticalAlign: 'middle',
          }}
        >
          {primaryString(r)}
        </span>
      ),
    },
    {
      id: 'source',
      header: 'Source',
      width: 140,
      sortValue: (r) => r.externalSource ?? 'manual',
      render: (r) =>
        r.externalSource ? (
          <Tag tone="info">{r.externalSource.toLowerCase()}</Tag>
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
        ),
    },
    {
      id: 'updated',
      header: 'Updated',
      width: 120,
      mono: true,
      sortValue: (r) => new Date(r.updatedAt),
      render: (r) => (
        <span style={{ color: 'var(--dim)' }}>{relative(new Date(r.updatedAt))}</span>
      ),
    },
    {
      id: 'open',
      header: '',
      width: 80,
      align: 'right',
      sortable: false,
      render: (r) => (
        <Link
          href={`/admin/companies/${companyId}/assets/${r.id}`}
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
      ),
    },
  ];
}

function primaryString(row: AssetSummary): string {
  const primary = row.fields.find((f) => f.isPrimary);
  if (!primary || !(primary.slug in row.fieldValues)) return '—';
  return renderScalar(
    row.fieldValues[primary.slug],
    primary.fieldType,
    row.references,
  );
}

function AssetMobileBody({
  row,
  companyId,
}: {
  row: AssetSummary;
  companyId: string;
}) {
  const primaryValue = primaryString(row);
  return (
    <Link
      href={`/admin/companies/${companyId}/assets/${row.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        color: 'inherit',
        opacity: row.archivedAt ? 0.7 : 1,
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
        <MobileCardRow label="Primary" mono>
          {primaryValue}
        </MobileCardRow>
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
  if (fieldType === 'VAULTWARDEN_LINK') return vaultLinkLabel(value) || '—';
  if (fieldType === 'TAGS' && Array.isArray(value)) {
    return (value as unknown[])
      .map((v) => {
        if (
          v &&
          typeof v === 'object' &&
          typeof (v as { name?: unknown }).name === 'string'
        ) {
          return (v as { name: string }).name;
        }
        return String(v);
      })
      .join(', ');
  }
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
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
