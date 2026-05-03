'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  AssetSummary,
  FieldType,
  LayoutFieldSummary,
  LayoutSummary,
} from '../../lib/server-api';
import { vaultLinkLabel } from '../../lib/vault-link';
import {
  DataTable,
  type DataColumn,
  Icon,
  LayoutSwatch,
  MobileCardRow,
  Tag,
} from '../ui';
import { TagFilterMenu } from './tag-filter-menu';

type ReferenceMap = AssetSummary['references'];

/**
 * Per-layout asset table. Columns come from the layout's field
 * configuration: primary field always leads, followed by every
 * field with `showInTable=true` in field `position` order. A
 * trailing "Updated" column is appended for reference — it lives
 * on the asset row itself, not on any field, so we can't make it
 * configurable.
 *
 * Shared between the admin (`/admin/companies/[id]/...`) and
 * portal (`/portal/[slug]/...`) shells. URL construction is
 * parameterised via `basePath` so neither side has to fork this
 * file: pass `/admin/companies/<id>` for the operator view, or
 * `/portal/<slug>` for the client view.
 *
 * Per-`FieldType` cell rendering makes the table feel "real" —
 * `BOOLEAN` becomes a check glyph, `TAGS`/`MULTISELECT` become
 * chips, `URL`/`EMAIL` become anchor tags, etc. Non-tabular types
 * (`RICH_TEXT`, `FILE`) are filtered out upstream; if one leaks
 * through it falls back to a monospace primitive so we never
 * throw from a DB-originated field the UI hasn't caught up with.
 */
export function LayoutAssetsTable({
  basePath,
  layout,
  rows,
  q,
  includeArchived,
  canManage,
}: {
  /** URL prefix for every outbound link (e.g. `/admin/companies/<id>`). */
  basePath: string;
  layout: LayoutSummary;
  rows: AssetSummary[];
  q: string;
  includeArchived: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(q);
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const columns = useMemo(() => {
    const primary = layout.fields.find((f) => f.isPrimary);
    const extras = layout.fields
      .filter((f) => f.showInTable && !f.isPrimary)
      .sort((a, b) => a.position - b.position);
    return { primary, extras };
  }, [layout.fields]);

  // TAGS field slugs on this layout. The filter is only meaningful when
  // the layout actually has at least one TAGS field, otherwise we don't
  // surface the dropdown at all.
  const tagFieldSlugs = useMemo(
    () =>
      layout.fields
        .filter((f) => f.fieldType === 'TAGS' && f.archivedAt === null)
        .map((f) => f.slug),
    [layout.fields],
  );

  // Distinct `{id, name}` chips referenced by the currently loaded rows.
  // The server hydrates TAGS values into chip objects, so we just walk
  // them here. Sort alphabetically for stable dropdown ordering.
  const availableTags = useMemo(() => {
    if (tagFieldSlugs.length === 0) return [] as Array<{ id: string; name: string }>;
    const byId = new Map<string, string>();
    for (const r of rows) {
      for (const slug of tagFieldSlugs) {
        const v = r.fieldValues[slug];
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
  }, [rows, tagFieldSlugs]);

  // Drop the tagFilter selection if the underlying tag list no longer
  // contains it (e.g. a search narrowed the rows past every reference).
  useEffect(() => {
    if (tagFilter && !availableTags.some((t) => t.id === tagFilter)) {
      setTagFilter(null);
    }
  }, [availableTags, tagFilter]);

  // Apply the client-side tag filter on top of the server-filtered rows.
  // Server-side TAGS filtering would require a JSON `?| array_contains`
  // query against `AssetFieldValue.value` — out of scope for v1. The
  // current page is capped at 200 rows so iterating in JS is cheap.
  const visibleRows = useMemo(() => {
    if (!tagFilter) return rows;
    return rows.filter((r) =>
      tagFieldSlugs.some((slug) => {
        const v = r.fieldValues[slug];
        if (!Array.isArray(v)) return false;
        return (v as unknown[]).some(
          (entry) =>
            entry &&
            typeof entry === 'object' &&
            (entry as { id?: unknown }).id === tagFilter,
        );
      }),
    );
  }, [rows, tagFieldSlugs, tagFilter]);

  const activeTag = tagFilter
    ? availableTags.find((t) => t.id === tagFilter) ?? null
    : null;

  function pushParams(next: Record<string, string | undefined | null>) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (includeArchived) params.set('archived', '1');
    for (const [k, v] of Object.entries(next)) {
      if (v == null || v === '') params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(`${basePath}/layouts/${layout.slug}${qs ? `?${qs}` : ''}`);
    });
  }

  function commitSearch() {
    pushParams({ q: draft.trim() || null });
  }

  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: '48px 24px',
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 13,
        }}
      >
        {q || includeArchived || tagFilter ? (
          <>No {layout.name} match the current filters.</>
        ) : (
          <div style={{ display: 'grid', placeItems: 'center', gap: 10 }}>
            <LayoutSwatch icon={layout.icon} color={layout.color} size={42} />
            <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
              No {layout.name} yet for this company.
            </div>
            {canManage && (
              <Link
                href={`${basePath}/assets/new?layout=${layout.id}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 30,
                  padding: '0 12px',
                  background: 'var(--accent)',
                  color: 'var(--accent-ink)',
                  borderRadius: 5,
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              >
                <Icon.plus size={13} />
                New {layout.name}
              </Link>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* Filter bar */}
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
          flexShrink: 0,
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
            placeholder={`Search ${layout.name}…`}
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
            className="hide-on-mobile"
            style={{ width: 1, height: 14, background: 'var(--line-2)' }}
          />
          <span
            className="hide-on-mobile"
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

      {/* Table / cards — `flex: 1; min-height: 0` so the DataTable's
          fillHeight scroll region claims the leftover viewport rather
          than the whole page scrolling under it. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {visibleRows.length === 0 ? (
          <div
            style={{
              padding: '40px 24px',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
            }}
          >
            No {layout.name} match the current filters.
          </div>
        ) : (
          <div
            style={{
              opacity: pending ? 0.6 : 1,
              transition: 'opacity 120ms ease',
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <DataTable
              fillHeight
              columns={layoutColumns({ layout, extras: columns.extras, basePath })}
              rows={visibleRows}
              renderMobileCard={(r) => (
                <LayoutAssetMobileBody
                  row={r}
                  layout={layout}
                  extras={columns.extras}
                  basePath={basePath}
                />
              )}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function layoutColumns({
  layout,
  extras,
  basePath,
}: {
  layout: LayoutSummary;
  extras: LayoutFieldSummary[];
  basePath: string;
}): DataColumn<AssetSummary>[] {
  const cols: DataColumn<AssetSummary>[] = [
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
          <LayoutSwatch icon={layout.icon} color={layout.color} size={22} />
          <Link
            href={`${basePath}/assets/${r.id}`}
            style={{
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 320,
              minWidth: 0,
              color: 'inherit',
            }}
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
  ];

  for (const f of extras) {
    cols.push({
      id: `field:${f.slug}`,
      header: f.name,
      width: 240,
      sortValue: (r) => fieldSortValue(f.fieldType, r.fieldValues[f.slug], r.references),
      render: (r) => (
        <FieldCell
          fieldType={f.fieldType}
          value={r.fieldValues[f.slug]}
          references={r.references}
        />
      ),
    });
  }

  cols.push({
    id: 'updated',
    header: 'Updated',
    width: 120,
    align: 'right',
    mono: true,
    sortValue: (r) => new Date(r.updatedAt),
    render: (r) => (
      <span style={{ color: 'var(--dim)', whiteSpace: 'nowrap' }}>
        {relative(new Date(r.updatedAt))}
      </span>
    ),
  });

  cols.push({
    id: 'open',
    header: '',
    width: 80,
    align: 'right',
    sortable: false,
    render: (r) => (
      <Link
        href={`${basePath}/assets/${r.id}`}
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
  });

  return cols;
}

function LayoutAssetMobileBody({
  row,
  layout,
  extras,
  basePath,
}: {
  row: AssetSummary;
  layout: LayoutSummary;
  extras: LayoutFieldSummary[];
  basePath: string;
}) {
  const updated = new Date(row.updatedAt);
  const firstTwoExtras = extras.slice(0, 2);
  return (
    <Link
      href={`${basePath}/assets/${row.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        color: 'inherit',
        opacity: row.archivedAt ? 0.7 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <LayoutSwatch icon={layout.icon} color={layout.color} size={24} />
        <div
          style={{
            flex: 1,
            minWidth: 0,
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
        <Icon.chevron size={12} style={{ color: 'var(--dim)' }} />
      </div>
      {firstTwoExtras.map((f) => (
        <MobileCardRow key={f.id} label={f.name}>
          <FieldCell
            fieldType={f.fieldType}
            value={row.fieldValues[f.slug]}
            references={row.references}
          />
        </MobileCardRow>
      ))}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        {row.archivedAt && <Tag tone="warn">archived</Tag>}
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--dim)',
          }}
        >
          {relative(updated)}
        </span>
      </div>
    </Link>
  );
}

/**
 * Sortable representation of an arbitrary field value. Keeps the
 * comparison stable across the heterogeneous shapes the API can return
 * (chip arrays for TAGS, ISO strings for DATE, raw strings/booleans/
 * numbers for the simple types). Returns null/undefined for empties so
 * the comparator naturally pushes them to the bottom.
 */
function fieldSortValue(
  type: FieldType,
  value: unknown,
  references: ReferenceMap,
): string | number | boolean | Date | null | undefined {
  if (value == null || value === '') return null;
  switch (type) {
    case 'BOOLEAN':
      return value === true || value === 'true';
    case 'NUMBER':
      return Number(value);
    case 'DATE':
    case 'DATETIME': {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d;
    }
    case 'TAGS':
    case 'MULTISELECT': {
      const arr = Array.isArray(value) ? (value as unknown[]) : [];
      if (arr.length === 0) return null;
      const first = arr[0];
      if (
        first &&
        typeof first === 'object' &&
        typeof (first as { name?: unknown }).name === 'string'
      ) {
        return ((first as { name: string }).name || '').toLowerCase();
      }
      return String(first ?? '').toLowerCase();
    }
    case 'ASSET_REFERENCE': {
      const ids = Array.isArray(value) ? value : [value];
      const id = String(ids[0] ?? '');
      const hit = references[id];
      return (hit?.name ?? id).toLowerCase();
    }
    default:
      return String(value).toLowerCase();
  }
}

function FieldCell({
  fieldType,
  value,
  references,
}: {
  fieldType: FieldType;
  value: unknown;
  references: ReferenceMap;
}) {
  if (value == null || value === '') return <Dim>—</Dim>;

  switch (fieldType) {
    case 'BOOLEAN': {
      const on = value === true || value === 'true';
      return on ? (
        <Icon.check size={14} style={{ color: 'var(--ok)' }} />
      ) : (
        <Dim>false</Dim>
      );
    }
    case 'DATE':
    case 'DATETIME': {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return <Dim>{String(value)}</Dim>;
      return (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
          {fieldType === 'DATETIME'
            ? d.toLocaleString()
            : d.toLocaleDateString()}
        </span>
      );
    }
    case 'URL': {
      const s = String(value);
      return (
        <a
          href={s}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: 'var(--accent)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'inline-block',
            maxWidth: '100%',
          }}
        >
          {stripProtocol(s)}
        </a>
      );
    }
    case 'EMAIL': {
      return (
        <a
          href={`mailto:${String(value)}`}
          onClick={(e) => e.stopPropagation()}
          style={{
            color: 'var(--accent)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
          }}
        >
          {String(value)}
        </a>
      );
    }
    case 'TAGS': {
      // Server-side `hydrateTagFields` rewrites the stored UUID array into
      // `{ id, name }` snapshots. Pre-migration data may still arrive as
      // raw strings — those degrade gracefully through the fallback below.
      if (!Array.isArray(value)) return <Dim>—</Dim>;
      const chips = (value as unknown[])
        .map((v) => {
          if (
            v &&
            typeof v === 'object' &&
            typeof (v as { name?: unknown }).name === 'string'
          ) {
            const obj = v as { id?: string; name: string };
            return { key: obj.id ?? obj.name, label: obj.name };
          }
          if (typeof v === 'string' && v.length > 0) {
            return { key: v, label: v };
          }
          return null;
        })
        .filter((x): x is { key: string; label: string } => x !== null);
      if (chips.length === 0) return <Dim>—</Dim>;
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {chips.slice(0, 4).map((c) => (
            <Tag key={c.key} tone="outline">
              {c.label}
            </Tag>
          ))}
          {chips.length > 4 && <Dim>+{chips.length - 4}</Dim>}
        </div>
      );
    }
    case 'MULTISELECT': {
      const arr = Array.isArray(value)
        ? value
        : String(value)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      if (arr.length === 0) return <Dim>—</Dim>;
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {arr.slice(0, 4).map((v, i) => (
            <Tag key={`${v}-${i}`} tone="outline">
              {String(v)}
            </Tag>
          ))}
          {arr.length > 4 && <Dim>+{arr.length - 4}</Dim>}
        </div>
      );
    }
    case 'NUMBER': {
      return (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
          {String(value)}
        </span>
      );
    }
    case 'IP_ADDRESS':
    case 'PHONE':
    case 'VAULTWARDEN_LINK': {
      const text =
        fieldType === 'VAULTWARDEN_LINK' ? vaultLinkLabel(value) : String(value);
      return (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--text-2)',
          }}
        >
          {text}
        </span>
      );
    }
    case 'ASSET_REFERENCE': {
      const ids = Array.isArray(value) ? value : [value];
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {ids.slice(0, 3).map((v, i) => {
            const id = String(v);
            const hit = references[id];
            const label = hit?.name ?? `${truncate(id, 8)} (missing)`;
            return (
              <span
                key={`${id}-${i}`}
                title={hit ? id : 'Referenced asset is no longer available'}
                style={{ display: 'inline-flex' }}
              >
                <Tag
                  tone={hit ? 'info' : 'outline'}
                  style={
                    hit?.archivedAt
                      ? { textDecoration: 'line-through', opacity: 0.75 }
                      : undefined
                  }
                >
                  {truncate(label, 28)}
                </Tag>
              </span>
            );
          })}
          {ids.length > 3 && <Dim>+{ids.length - 3}</Dim>}
        </div>
      );
    }
    case 'DROPDOWN':
    case 'TEXT':
    case 'TEXTAREA':
    default:
      return (
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'inline-block',
            maxWidth: '100%',
            color: 'var(--text-2)',
          }}
        >
          {renderCellPrimitive(fieldType, value, references)}
        </span>
      );
  }
}

function Dim({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--dim)',
      }}
    >
      {children}
    </span>
  );
}

function renderCellPrimitive(
  type: FieldType,
  value: unknown,
  references?: ReferenceMap,
): string {
  if (value == null) return '—';
  if (type === 'ASSET_REFERENCE' && references) {
    const ids = Array.isArray(value) ? value : [value];
    return ids
      .map((v) => {
        const id = String(v);
        return references[id]?.name ?? `${truncate(id, 8)} (missing)`;
      })
      .join(', ');
  }
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function stripProtocol(s: string): string {
  return s.replace(/^https?:\/\//i, '');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
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
