'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  DataTable,
  type DataColumn,
  Icon,
  MobileCardRow,
  Tag,
} from '../../../../components/ui';
import type {
  TicketListFilters,
  TicketListItem,
} from '../../../../lib/server-api';
import {
  formatTicketBoard,
  formatTicketPriority,
  formatTicketStatus,
  priorityTone,
  statusTone,
} from './ticket-formatting';

/**
 * Phase 12+ — global admin tickets browser. URL is the source of
 * truth for every filter + the pagination cursor so deep links / back
 * behave. The table itself is read-only — selecting a ticket routes
 * to the detail page, where the chat panel auto-attaches it as
 * context. Article creation uses the chat panel's existing
 * "Save as article" dialog, which prompts the operator to pick the
 * target company at save time.
 *
 * Differences vs the legacy per-company browser:
 *   - Adds a **Company** column (resolved Weavestream name with a
 *     link to that company's detail page, or a muted "(unmapped
 *     client …)" label when the upstream client id has no mapping).
 *   - Drops the **Assignee** and **Requester** columns — NinjaOne
 *     returns opaque user ids that aren't useful to render without
 *     an extra per-user fetch. The detail view keeps them for the
 *     AI's context.
 */
export function TicketsBrowser({
  rows,
  cursor,
  filter,
  activeCursor,
  actorId: _actorId,
  integrationEnabled,
}: {
  rows: TicketListItem[];
  cursor: string | null;
  filter: TicketListFilters;
  activeCursor: string | null;
  actorId: string;
  integrationEnabled: boolean;
}) {
  const router = useRouter();
  const [_pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(filter.search ?? '');

  const base = `/admin/tickets`;

  // Reset the DataTable's scroll position to the top whenever the
  // active cursor changes (i.e., the operator clicked Next page /
  // First page). React's router preserves scroll across same-route
  // pushes, so without this the new page lands mid-scroll on long
  // pages. DataTable owns its own overflow container — we look it
  // up by the `data-scrolled` attribute it sets for its left-edge
  // shadow.
  const tableHostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = tableHostRef.current;
    if (!host) return;
    const scroller = host.querySelector<HTMLElement>('[data-scrolled]');
    if (scroller) scroller.scrollTop = 0;
    else host.scrollTop = 0;
  }, [activeCursor, cursor]);

  function pushParams(next: Record<string, string | undefined | null>) {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.priority) params.set('priority', filter.priority);
    if (filter.boardId) params.set('boardId', filter.boardId);
    if (filter.search) params.set('search', filter.search);
    // Filter changes always reset the cursor — paginated results don't
    // make sense once the underlying list shape changes.
    let resetCursor = false;
    for (const [k, v] of Object.entries(next)) {
      if (k === 'cursor') continue;
      if (v == null || v === '') params.delete(k);
      else params.set(k, v);
      resetCursor = true;
    }
    if (resetCursor) {
      params.delete('cursor');
    } else if (next.cursor != null && next.cursor !== '') {
      params.set('cursor', String(next.cursor));
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(`${base}${qs ? `?${qs}` : ''}`);
    });
  }

  function commitSearch() {
    const trimmed = draft.trim();
    pushParams({ search: trimmed.length === 0 ? null : trimmed });
  }

  function clearAll() {
    setDraft('');
    startTransition(() => {
      router.push(base);
    });
  }

  const hasFilters = useMemo(
    () =>
      Boolean(
        filter.status || filter.priority || filter.boardId || filter.search,
      ),
    [filter],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      }}
    >
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
            placeholder="Search subject…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 12.5,
              color: 'var(--text)',
            }}
          />
        </div>

        <FilterSelect
          value={filter.status ?? ''}
          options={[
            { value: '', label: 'Any status' },
            { value: 'open', label: 'Open' },
            { value: 'pending', label: 'Pending' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'closed', label: 'Closed' },
          ]}
          onChange={(v) => pushParams({ status: v || null })}
        />
        <FilterSelect
          value={filter.priority ?? ''}
          options={[
            { value: '', label: 'Any priority' },
            { value: 'urgent', label: 'Urgent' },
            { value: 'high', label: 'High' },
            { value: 'normal', label: 'Normal' },
            { value: 'low', label: 'Low' },
            { value: 'none', label: 'None' },
          ]}
          onChange={(v) => pushParams({ priority: v || null })}
        />

        {hasFilters && (
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
              padding: '0 6px',
              height: 28,
            }}
          >
            clear all
          </button>
        )}
      </div>

      {filter.boardId && (
        <div
          style={{
            padding: '8px 14px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
            background: 'var(--surface)',
            flexShrink: 0,
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
          <Chip onRemove={() => pushParams({ boardId: null })}>
            board: {filter.boardId}
          </Chip>
        </div>
      )}

      <div
        ref={tableHostRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {!integrationEnabled ? (
          <div
            style={{
              padding: 36,
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
            }}
          >
            No ticketing-capable integration is enabled. Configure one in{' '}
            <Link href="/admin/integrations" style={{ color: 'var(--accent)' }}>
              Integrations
            </Link>{' '}
            to start browsing tickets.
          </div>
        ) : rows.length === 0 ? (
          <div
            style={{
              padding: 36,
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
            }}
          >
            {hasFilters
              ? 'No tickets match the current filters.'
              : 'No tickets in the connected ticketing system.'}
          </div>
        ) : (
          <DataTable
            fillHeight
            columns={ticketColumns()}
            rows={rows}
            renderMobileCard={(r) => <TicketMobileCard row={r} />}
          />
        )}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '10px 14px',
          borderTop: '1px solid var(--line)',
          flexShrink: 0,
        }}
      >
        <span style={{ flex: 1 }} />
        {activeCursor && (
          <button
            type="button"
            onClick={() => pushParams({ cursor: null })}
            style={pagerBtnStyle()}
          >
            <Icon.chevron size={11} style={{ transform: 'rotate(180deg)' }} />
            First page
          </button>
        )}
        {cursor && (
          <button
            type="button"
            onClick={() => pushParams({ cursor })}
            style={pagerBtnStyle()}
          >
            Next page
            <Icon.chevron size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

function ticketColumns(): DataColumn<TicketListItem>[] {
  return [
    {
      id: 'subject',
      header: 'Subject',
      width: 360,
      sortValue: (r) => r.subject.toLowerCase(),
      render: (r) => (
        <span
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            gap: 2,
            maxWidth: 340,
          }}
        >
          <Link
            href={`/admin/tickets/${encodeURIComponent(r.id)}`}
            style={{
              color: 'inherit',
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 340,
            }}
          >
            {r.subject || '(no subject)'}
          </Link>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {r.displayId ?? r.id} · {formatTicketBoard(r)}
          </span>
        </span>
      ),
    },
    {
      id: 'company',
      header: 'Company',
      width: 220,
      sortValue: (r) => r.companyName?.toLowerCase() ?? '\uffff',
      render: (r) => <CompanyCell row={r} />,
    },
    {
      id: 'status',
      header: 'Status',
      width: 140,
      sortValue: (r) => r.status,
      render: (r) => <Tag tone={statusTone(r.status)}>{formatTicketStatus(r)}</Tag>,
    },
    {
      id: 'priority',
      header: 'Priority',
      width: 120,
      sortValue: (r) => r.priority,
      render: (r) => (
        <Tag tone={priorityTone(r.priority)}>
          {formatTicketPriority(r.priority)}
        </Tag>
      ),
    },
    {
      id: 'created',
      header: 'Opened',
      width: 110,
      mono: true,
      sortValue: (r) => (r.createdAt ? new Date(r.createdAt) : new Date(0)),
      render: (r) => (
        <span
          style={{ color: 'var(--dim)' }}
          title={r.createdAt ?? undefined}
        >
          {r.createdAt ? relative(new Date(r.createdAt)) : '—'}
        </span>
      ),
    },
    {
      id: 'updated',
      header: 'Updated',
      width: 110,
      mono: true,
      sortValue: (r) => (r.updatedAt ? new Date(r.updatedAt) : new Date(0)),
      render: (r) => (
        <span
          style={{ color: 'var(--dim)' }}
          title={r.updatedAt ?? undefined}
        >
          {r.updatedAt ? relative(new Date(r.updatedAt)) : '—'}
        </span>
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
          href={`/admin/tickets/${encodeURIComponent(r.id)}`}
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

function CompanyCell({ row }: { row: TicketListItem }) {
  if (row.companyId && row.companyName) {
    return (
      <Link
        href={`/admin/companies/${row.companyId}`}
        style={{
          color: 'var(--text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'inline-block',
          maxWidth: 200,
        }}
      >
        {row.companyName}
      </Link>
    );
  }
  return (
    <span
      style={{
        color: 'var(--dim)',
        fontStyle: 'italic',
        fontSize: 12,
      }}
    >
      {row.externalClientId
        ? `unmapped client ${row.externalClientId}`
        : 'unmapped'}
    </span>
  );
}

function TicketMobileCard({ row }: { row: TicketListItem }) {
  return (
    <Link
      href={`/admin/tickets/${encodeURIComponent(row.id)}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
        }}
      >
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
            {row.subject || '(no subject)'}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.displayId ?? row.id} · {formatTicketBoard(row)}
          </div>
        </div>
        <Icon.chevron size={12} style={{ color: 'var(--dim)' }} />
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <Tag tone={statusTone(row.status)}>{formatTicketStatus(row)}</Tag>
        <Tag tone={priorityTone(row.priority)}>
          {formatTicketPriority(row.priority)}
        </Tag>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--dim)',
          }}
        >
          {row.updatedAt ? relative(new Date(row.updatedAt)) : '—'}
        </span>
      </div>
      <MobileCardRow label="Company">
        {row.companyId && row.companyName ? (
          row.companyName
        ) : (
          <span style={{ color: 'var(--dim)', fontStyle: 'italic' }}>
            {row.externalClientId
              ? `unmapped client ${row.externalClientId}`
              : 'unmapped'}
          </span>
        )}
      </MobileCardRow>
      {row.createdAt && (
        <MobileCardRow label="Opened">
          <span title={row.createdAt}>{relative(new Date(row.createdAt))}</span>
        </MobileCardRow>
      )}
    </Link>
  );
}

function FilterSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
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
      {options.map((o) => (
        <option key={o.value || '__any'} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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
        aria-label="Remove filter"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          padding: 0,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <Icon.x size={9} />
      </button>
    </span>
  );
}

function pagerBtnStyle(): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 28,
    padding: '0 10px',
    background: 'var(--panel-2)',
    border: '1px solid var(--line-2)',
    borderRadius: 5,
    fontSize: 12,
    color: 'var(--text)',
    cursor: 'pointer',
  };
}

function relative(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 0) return 'just now';
  const day = 86_400_000;
  if (diff < day) return 'today';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
}
