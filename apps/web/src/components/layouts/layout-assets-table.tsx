'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  AssetSummary,
  FieldType,
  LayoutFieldSummary,
  LayoutSummary,
} from '../../lib/server-api';
import { Icon, LayoutSwatch, Tag } from '../ui';
import { useIsMobile } from '../../lib/hooks/use-is-mobile';

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
  const isMobile = useIsMobile();

  const columns = useMemo(() => {
    const primary = layout.fields.find((f) => f.isPrimary);
    const extras = layout.fields
      .filter((f) => f.showInTable && !f.isPrimary)
      .sort((a, b) => a.position - b.position);
    return { primary, extras };
  }, [layout.fields]);

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
        {q || includeArchived ? (
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
          {!isMobile && (
            <>
              <span style={{ width: 1, height: 14, background: 'var(--line-2)' }} />
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--muted)',
                  whiteSpace: 'nowrap',
                }}
              >
                {rows.length} results
              </span>
            </>
          )}
        </div>

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

      {/* Table / cards */}
      {isMobile ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            opacity: pending ? 0.6 : 1,
          }}
        >
          {rows.map((r) => (
            <LayoutAssetMobileCard
              key={r.id}
              row={r}
              layout={layout}
              columns={columns}
              basePath={basePath}
            />
          ))}
        </ul>
      ) : (
        <div style={{ overflow: 'auto', opacity: pending ? 0.6 : 1 }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12.5,
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                <Th>Name</Th>
                {columns.extras.map((f) => (
                  <Th key={f.id}>{f.name}</Th>
                ))}
                <Th style={{ textAlign: 'right' }}>Updated</Th>
                <Th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <AssetRow
                  key={r.id}
                  row={r}
                  layout={layout}
                  columns={columns}
                  basePath={basePath}
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

function LayoutAssetMobileCard({
  row,
  layout,
  columns,
  basePath,
}: {
  row: AssetSummary;
  layout: LayoutSummary;
  columns: {
    primary: LayoutFieldSummary | undefined;
    extras: LayoutFieldSummary[];
  };
  basePath: string;
}) {
  const updated = new Date(row.updatedAt);
  const firstTwoExtras = columns.extras.slice(0, 2);
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
        href={`${basePath}/assets/${row.id}`}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 12,
          color: 'inherit',
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
        {firstTwoExtras.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {firstTwoExtras.map((f) => (
              <div
                key={f.id}
                style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    textTransform: 'uppercase',
                    letterSpacing: 0.6,
                    color: 'var(--dim)',
                    minWidth: 64,
                  }}
                >
                  {f.name}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    color: 'var(--text-2)',
                    wordBreak: 'break-word',
                  }}
                >
                  <FieldCell
                    fieldType={f.fieldType}
                    value={row.fieldValues[f.slug]}
                    references={row.references}
                  />
                </span>
              </div>
            ))}
          </div>
        )}
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
    </li>
  );
}

function Th({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '8px 12px',
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        color: 'var(--muted)',
        fontWeight: 400,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function AssetRow({
  row,
  layout,
  columns,
  basePath,
  isLast,
}: {
  row: AssetSummary;
  layout: LayoutSummary;
  columns: {
    primary: LayoutFieldSummary | undefined;
    extras: LayoutFieldSummary[];
  };
  basePath: string;
  isLast: boolean;
}) {
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
          href={`${basePath}/assets/${row.id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'inherit',
          }}
        >
          <LayoutSwatch icon={layout.icon} color={layout.color} size={22} />
          <div
            style={{
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 320,
              minWidth: 0,
            }}
          >
            {row.name}
            {row.archivedAt && (
              <Tag tone="warn" style={{ marginLeft: 8 }}>
                archived
              </Tag>
            )}
          </div>
        </Link>
      </td>
      {columns.extras.map((f) => (
        <td
          key={f.id}
          style={{
            padding: '0 12px',
            maxWidth: 240,
          }}
        >
          <FieldCell
            fieldType={f.fieldType}
            value={row.fieldValues[f.slug]}
            references={row.references}
          />
        </td>
      ))}
      <td
        style={{
          padding: '0 12px',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--dim)',
          textAlign: 'right',
          whiteSpace: 'nowrap',
        }}
      >
        {relative(updated)}
      </td>
      <td style={{ padding: '0 12px', textAlign: 'right' }}>
        <Link
          href={`${basePath}/assets/${row.id}`}
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
    case 'TAGS':
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
      return (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            color: 'var(--text-2)',
          }}
        >
          {String(value)}
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
