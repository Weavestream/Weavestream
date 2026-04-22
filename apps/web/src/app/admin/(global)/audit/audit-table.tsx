'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Btn,
  DataTable,
  Dialog,
  Icon,
  Input,
  MobileCardRow,
  Pagination,
  Select,
  Tag,
  type DataColumn,
  type TagTone,
} from '../../../../components/ui';
import type { AuditEntry } from '../../../../lib/server-api';
import { lower } from '../../../../lib/term';
import { useTerm } from '../../../../lib/term-context';

const ACTION_PREFIXES = [
  { value: '', label: 'All actions' },
  { value: 'auth', label: 'auth.*' },
  { value: 'user', label: 'user.*' },
  { value: 'company', label: 'company.*' },
  { value: 'membership', label: 'membership.*' },
  { value: 'layout', label: 'layout.*' },
  { value: 'asset', label: 'asset.*' },
  { value: 'article', label: 'article.*' },
  { value: 'folder', label: 'folder.*' },
  { value: 'password', label: 'password.*' },
  { value: 'upload', label: 'upload.*' },
  { value: 'domain', label: 'domain.*' },
  { value: 'settings', label: 'settings.*' },
];

/**
 * Phase 9a audit table. Each row is clickable — clicking opens a
 * detail drawer with the resolved entity / company names and a
 * field-level before/after diff rendered from the JSON payload.
 */
export function AuditTable({
  rows,
  filters,
  page,
  pageSize,
  total,
  pageSizeOptions,
  companies,
  requireCompany,
}: {
  rows: AuditEntry[];
  filters: { companyId?: string; action?: string; from?: string; to?: string };
  page: number;
  pageSize: number;
  total: number;
  pageSizeOptions: number[];
  companies: Array<{ id: string; name: string; slug: string }>;
  requireCompany: boolean;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [action, setAction] = useState(filters.action ?? '');
  const [from, setFrom] = useState(filters.from ?? '');
  const [to, setTo] = useState(filters.to ?? '');
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const term = useTerm();

  useEffect(() => {
    setAction(filters.action ?? '');
    setFrom(filters.from ?? '');
    setTo(filters.to ?? '');
  }, [filters.action, filters.from, filters.to]);

  const columns = useMemo<DataColumn<AuditEntry>[]>(
    () => [
      {
        id: 'when',
        header: 'When',
        width: 170,
        mono: true,
        render: (r) => (
          <span style={{ color: 'var(--dim)' }}>
            {new Date(r.createdAt).toLocaleString()}
          </span>
        ),
      },
      {
        id: 'action',
        header: 'Action',
        width: 200,
        render: (r) => (
          <Tag tone={toneFor(r.action)}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.action}</span>
          </Tag>
        ),
      },
      {
        id: 'actor',
        header: 'Actor',
        width: 200,
        render: (r) =>
          r.actor ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ color: 'var(--text)' }}>{r.actor.name}</span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--dim)',
                }}
              >
                {r.actor.email}
              </span>
            </div>
          ) : (
            <span style={{ color: 'var(--dim)' }}>system</span>
          ),
      },
      {
        id: 'entity',
        header: 'Entity',
        render: (r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ color: 'var(--text)', fontSize: 13 }}>
              {r.entityName ?? (r.entityType ? `${r.entityType}` : '—')}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              {r.entityType ?? '—'}
              {r.entityId ? ` · ${r.entityId.slice(0, 8)}` : ''}
            </span>
          </div>
        ),
      },
      {
        id: 'company',
        header: 'Company',
        width: 180,
        render: (r) =>
          r.companyName ? (
            <span style={{ color: 'var(--text-2)', fontSize: 12.5 }}>
              {r.companyName}
            </span>
          ) : (
            <span style={{ color: 'var(--dim)' }}>—</span>
          ),
      },
      {
        id: 'ip',
        header: 'IP',
        width: 140,
        mono: true,
        render: (r) => <span style={{ color: 'var(--dim)' }}>{r.ip ?? '—'}</span>,
      },
    ],
    [],
  );

  function setParams(mutate: (params: URLSearchParams) => void) {
    const next = new URLSearchParams(sp.toString());
    mutate(next);
    next.delete('page');
    router.replace(`/admin/audit?${next.toString()}`);
  }

  function buildAuditHref(nextPage: number, nextPageSize: number) {
    const q = new URLSearchParams(sp.toString());
    if (nextPage <= 1) q.delete('page');
    else q.set('page', String(nextPage));
    q.set('pageSize', String(nextPageSize));
    return `/admin/audit?${q.toString()}`;
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
        <Select
          value={filters.companyId ?? ''}
          onChange={(e) =>
            setParams((p) => {
              if (e.target.value) p.set('companyId', e.target.value);
              else p.delete('companyId');
            })
          }
          style={{ width: 220, height: 28 }}
        >
          <option value="">
            {requireCompany
              ? `Select ${lower(term.one)}…`
              : `All ${lower(term.other)}`}
          </option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setParams((p) => {
              if (e.target.value) p.set('action', e.target.value);
              else p.delete('action');
            });
          }}
          style={{ width: 170, height: 28 }}
        >
          {ACTION_PREFIXES.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </Select>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: 'var(--muted)',
          }}
        >
          <Icon.clock size={12} />
          from
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            onBlur={() =>
              setParams((p) => {
                if (from) p.set('from', from);
                else p.delete('from');
              })
            }
            style={{ height: 28, width: 140 }}
          />
          to
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onBlur={() =>
              setParams((p) => {
                if (to) p.set('to', to);
                else p.delete('to');
              })
            }
            style={{ height: 28, width: 140 }}
          />
        </div>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        onRowClick={(r) => setSelected(r)}
        empty={
          requireCompany && !filters.companyId
            ? `Select a ${lower(term.one)} to view its audit log.`
            : 'No events match these filters.'
        }
        renderMobileCard={(r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 8,
                justifyContent: 'space-between',
              }}
            >
              <Tag tone={toneFor(r.action)}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {r.action}
                </span>
              </Tag>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--dim)',
                }}
              >
                {new Date(r.createdAt).toLocaleString()}
              </span>
            </div>
            {(r.entityName || r.entityType) && (
              <div>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 500,
                    color: 'var(--text)',
                  }}
                >
                  {r.entityName ?? r.entityType}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--dim)',
                  }}
                >
                  {r.entityType ?? '—'}
                  {r.entityId ? ` · ${r.entityId.slice(0, 8)}` : ''}
                </div>
              </div>
            )}
            <MobileCardRow label="Actor">
              {r.actor ? (
                <>
                  <div>{r.actor.name}</div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--dim)',
                    }}
                  >
                    {r.actor.email}
                  </div>
                </>
              ) : (
                <span style={{ color: 'var(--dim)' }}>system</span>
              )}
            </MobileCardRow>
            {r.companyName && (
              <MobileCardRow label="Company">{r.companyName}</MobileCardRow>
            )}
            {r.ip && (
              <MobileCardRow label="IP" mono>
                {r.ip}
              </MobileCardRow>
            )}
          </div>
        )}
      />
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        buildHref={buildAuditHref}
        onPageSizeChange={(next) => {
          const q = new URLSearchParams(sp.toString());
          q.set('pageSize', String(next));
          q.delete('page');
          router.replace(`/admin/audit?${q.toString()}`);
        }}
        pageSizeOptions={pageSizeOptions}
      />
      <AuditDetailDrawer
        entry={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Detail drawer
// ───────────────────────────────────────────────────────────────────

function AuditDetailDrawer({
  entry,
  onClose,
}: {
  entry: AuditEntry | null;
  onClose: () => void;
}) {
  if (!entry) return null;
  const diff = buildDiffRows(entry.before ?? null, entry.after ?? null);
  return (
    <Dialog
      open={!!entry}
      onClose={onClose}
      width={760}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <Tag tone={toneFor(entry.action)}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              {entry.action}
            </span>
          </Tag>
          {entry.entityName && (
            <span style={{ fontSize: 14, fontWeight: 500 }}>{entry.entityName}</span>
          )}
        </span>
      }
      footer={
        <Btn kind="primary" onClick={onClose} icon={Icon.x}>
          Close
        </Btn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <MetaGrid entry={entry} />
        {diff.length > 0 ? (
          <DiffTable diff={diff} />
        ) : (
          <RawPayload entry={entry} />
        )}
      </div>
    </Dialog>
  );
}

function MetaGrid({ entry }: { entry: AuditEntry }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'max-content 1fr',
        rowGap: 6,
        columnGap: 14,
        fontSize: 12.5,
        padding: '10px 12px',
        background: 'var(--panel-2)',
        border: '1px solid var(--line)',
        borderRadius: 5,
      }}
    >
      <MetaLabel>When</MetaLabel>
      <span style={{ fontFamily: 'var(--font-mono)' }}>
        {new Date(entry.createdAt).toLocaleString()}
      </span>
      <MetaLabel>Actor</MetaLabel>
      <span>
        {entry.actor
          ? `${entry.actor.name} · ${entry.actor.email}`
          : 'system'}
      </span>
      {entry.entityType && (
        <>
          <MetaLabel>Entity</MetaLabel>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            {entry.entityName ? (
              <>
                <span style={{ fontWeight: 500 }}>{entry.entityName}</span>
                <span style={{ color: 'var(--dim)', fontSize: 12 }}>
                  {entry.entityType}
                </span>
              </>
            ) : (
              <span>{entry.entityType}</span>
            )}
            {entry.entityId && (
              <code
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--dim)',
                }}
              >
                {entry.entityId}
              </code>
            )}
          </span>
        </>
      )}
      {entry.companyName && (
        <>
          <MetaLabel>Company</MetaLabel>
          <span>{entry.companyName}</span>
        </>
      )}
      {entry.ip && (
        <>
          <MetaLabel>IP</MetaLabel>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{entry.ip}</span>
        </>
      )}
    </div>
  );
}

function MetaLabel({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--muted)',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}

function DiffTable({ diff }: { diff: DiffRow[] }) {
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 5,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(120px, 1fr) minmax(160px, 2fr) minmax(160px, 2fr)',
          padding: '8px 12px',
          background: 'var(--panel-2)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          borderBottom: '1px solid var(--line)',
        }}
      >
        <span>Field</span>
        <span>Before</span>
        <span>After</span>
      </div>
      {diff.map((row, i) => (
        <div
          key={row.key}
          style={{
            display: 'grid',
            gridTemplateColumns:
              'minmax(120px, 1fr) minmax(160px, 2fr) minmax(160px, 2fr)',
            padding: '8px 12px',
            borderBottom: i === diff.length - 1 ? 'none' : '1px solid var(--line)',
            fontSize: 12.5,
            alignItems: 'start',
          }}
        >
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text)' }}>
            {row.key}
          </code>
          <DiffCell value={row.before} kind="before" />
          <DiffCell value={row.after} kind="after" />
        </div>
      ))}
    </div>
  );
}

function DiffCell({ value, kind }: { value: unknown; kind: 'before' | 'after' }) {
  const color =
    value === null || value === undefined
      ? 'var(--dim)'
      : kind === 'before'
        ? 'var(--danger)'
        : 'var(--ok)';
  return (
    <span
      style={{
        fontFamily: typeof value === 'object' ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: 12,
        color,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {formatValue(value)}
    </span>
  );
}

function RawPayload({ entry }: { entry: AuditEntry }) {
  const has = entry.before || entry.after;
  if (!has) {
    return (
      <div
        style={{
          padding: 14,
          textAlign: 'center',
          color: 'var(--dim)',
          fontSize: 12.5,
        }}
      >
        No payload recorded for this event.
      </div>
    );
  }
  return (
    <pre
      style={{
        margin: 0,
        padding: 12,
        fontSize: 11.5,
        fontFamily: 'var(--font-mono)',
        background: 'var(--panel-2)',
        border: '1px solid var(--line)',
        borderRadius: 5,
        maxHeight: 320,
        overflow: 'auto',
      }}
    >
      {JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}
    </pre>
  );
}

// ───────────────────────────────────────────────────────────────────
// Diff helpers
// ───────────────────────────────────────────────────────────────────

type DiffRow = { key: string; before: unknown; after: unknown };

/**
 * Produce a flat list of keys that changed between the before and
 * after snapshots. Only emits rows where the values actually differ —
 * the API's `logChange` helper already filters no-op keys, but we run
 * the same check client-side so we render tidy diffs for legacy rows
 * produced before Phase 9a's diffing lands.
 */
function buildDiffRows(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): DiffRow[] {
  if (!before && !after) return [];
  const keys = new Set<string>();
  if (before) for (const k of Object.keys(before)) keys.add(k);
  if (after) for (const k of Object.keys(after)) keys.add(k);
  const rows: DiffRow[] = [];
  for (const key of Array.from(keys).sort()) {
    const b = before?.[key] ?? null;
    const a = after?.[key] ?? null;
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    rows.push({ key, before: b, after: a });
  }
  return rows;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function toneFor(action: string): TagTone {
  if (action.startsWith('auth.')) return 'info';
  if (
    action.startsWith('user.mfa') ||
    action.includes('revoke') ||
    action.includes('deactivate')
  ) {
    return 'warn';
  }
  if (action.startsWith('company.')) return 'accent';
  if (action.startsWith('membership.')) return 'ok';
  if (action.startsWith('layout.')) return 'info';
  if (action.includes('remove') || action.includes('archive') || action.includes('delete')) {
    return 'danger';
  }
  return 'default';
}
