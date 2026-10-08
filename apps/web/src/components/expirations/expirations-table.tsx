'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { expirationRowIdentity, type ExpirationRow } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import {
  Btn,
  DataTable,
  Dialog,
  Field,
  Icon,
  Input,
  LayoutSwatch,
  MobileCardRow,
  Tag,
  useToast,
  type DataColumn,
} from '../ui';
import {
  FormattedCalendarDate,
  FormattedDateTime,
} from '../../lib/timezone-context';

/**
 * Unified "Expiring soon" table. Rows come pre-sorted by the API
 * (most overdue first). The company column is only rendered in
 * cross-tenant mode so the scoped variant keeps a tighter layout and
 * doesn't repeat the already-visible tenant name on every row.
 *
 * On mobile we swap the table for the shared `DataTable` card layout
 * — same component the rest of the admin surfaces use — so each row
 * reads as a self-contained card with label/value pairs.
 */
export function ExpirationsTable({
  rows,
  showCompany,
}: {
  /** Rows may carry `dismissal` when the page asked for dismissed items too. */
  rows: ExpirationRow[];
  /**
   * Show the "Company" column. Set when rendering the global
   * cross-tenant feed; omit for the company-scoped view, where every
   * row belongs to the same tenant anyway.
   */
  showCompany: boolean;
}) {
  const dataRows = useMemo(
    () => rows.map((r) => ({ ...r, id: rowKey(r) })),
    [rows],
  );
  const [dismissing, setDismissing] = useState<ExpirationRow | null>(null);

  const columns = useMemo<DataColumn<(typeof dataRows)[number]>[]>(() => {
    const base: DataColumn<(typeof dataRows)[number]>[] = [
      {
        id: 'status',
        header: 'Status',
        width: 92,
        render: (row) => <StatusPill row={row} />,
      },
      {
        id: 'item',
        header: 'Item',
        render: (row) => <ItemCell row={row} />,
      },
      {
        id: 'source',
        header: 'Source',
        width: 160,
        render: (row) => <SourceCell row={row} />,
      },
    ];
    if (showCompany) {
      base.push({
        id: 'company',
        header: 'Company',
        width: 180,
        render: (row) => (
          <Link
            href={`/admin/companies/${row.companyId}`}
            style={{ color: 'var(--text)', fontWeight: 500 }}
          >
            {row.companyName}
          </Link>
        ),
      });
    }
    base.push({
      id: 'expires',
      header: 'Expires',
      width: 170,
      mono: true,
      render: (row) => (
        <span style={{ color: 'var(--text-2)' }}>
          <ExpiresValue row={row} />
        </span>
      ),
    });
    base.push({
      id: 'days',
      header: 'Days',
      width: 90,
      mono: true,
      render: (row) => (
        <span style={{ color: daysColor(row.daysUntil), fontWeight: 500 }}>
          {formatDays(row.daysUntil)}
        </span>
      ),
    });
    base.push({
      id: 'actions',
      header: '',
      width: 110,
      render: (row) => <DismissAction row={row} onDismiss={setDismissing} />,
    });
    return base;
  }, [showCompany]);

  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 40,
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 13,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            background: 'var(--ok-soft)',
            color: 'var(--ok)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Icon.check size={18} stroke={2} />
        </div>
        <div>Nothing expiring in the next 30 days.</div>
      </div>
    );
  }

  return (
    <>
    <DismissDialog row={dismissing} onClose={() => setDismissing(null)} />
    <DataTable
      columns={columns}
      rows={dataRows}
      disableSort
      rowHref={(row) => detailHref(row)}
      renderMobileCard={(row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <ItemCell row={row} asLink={false} />
            <span style={{ marginLeft: 'auto' }}>
              <StatusPill row={row} />
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
            }}
          >
            <SourceCell row={row} />
            {showCompany && (
              <Tag tone="outline">{row.companyName}</Tag>
            )}
          </div>
          <MobileCardRow label="Expires" mono>
            <ExpiresValue row={row} />
          </MobileCardRow>
          <MobileCardRow label="Days" mono>
            <span style={{ color: daysColor(row.daysUntil), fontWeight: 500 }}>
              {formatDays(row.daysUntil)}
            </span>
          </MobileCardRow>
          <DismissAction row={row} onDismiss={setDismissing} />
        </div>
      )}
    />
    </>
  );
}

/**
 * Dismiss hides a row for its current due date; a dismissed row (shown only
 * with "Show dismissed") offers Restore. The server checks permission.
 */
function DismissAction({
  row,
  onDismiss,
}: {
  row: ExpirationRow;
  onDismiss: (row: ExpirationRow) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  if (row.dismissal) {
    const dismissalId = row.dismissal.id;
    return (
      <Btn
        kind="ghost"
        size="sm"
        loading={pending}
        aria-label={`Restore ${itemLabel(row)}`}
        onClick={async () => {
          setPending(true);
          try {
            const res = await apiFetch(
              `/companies/${row.companyId}/expirations/dismissals/${dismissalId}`,
              { method: 'DELETE' },
            );
            if (!res.ok) {
              toast.push('Could not restore the item.', 'danger');
              return;
            }
            router.refresh();
          } catch {
            toast.push('Could not restore the item.', 'danger');
          } finally {
            setPending(false);
          }
        }}
      >
        Restore
      </Btn>
    );
  }
  return (
    <Btn kind="ghost" size="sm" aria-label={`Dismiss ${itemLabel(row)}`} onClick={() => onDismiss(row)}>
      Dismiss
    </Btn>
  );
}

function DismissDialog({ row, onClose }: { row: ExpirationRow | null; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);

  function close() {
    if (pending) return;
    setNote('');
    onClose();
  }

  async function submit() {
    if (!row) return;
    const { entityId, source } = expirationRowIdentity(row);
    setPending(true);
    try {
      const res = await apiFetch(`/companies/${row.companyId}/expirations/dismissals`, {
        method: 'POST',
        body: JSON.stringify({
          kind: row.kind,
          entityId,
          source,
          dueAt: row.expiresAt,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const p = res.problem as { detail?: string; title?: string } | undefined;
        toast.push(p?.detail ?? p?.title ?? 'Could not dismiss the item.', 'danger');
        return;
      }
      toast.push('Dismissed. It comes back if the date changes.', 'ok');
      setNote('');
      onClose();
      router.refresh();
    } catch {
      toast.push('Could not dismiss the item.', 'danger');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={row !== null}
      onClose={close}
      title="Dismiss from Expiring soon"
      width={460}
      footer={
        <>
          <Btn kind="outline" onClick={close} disabled={pending}>
            Cancel
          </Btn>
          <Btn kind="primary" loading={pending} onClick={submit}>
            Dismiss
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          {row ? <strong>{itemLabel(row)}</strong> : null} stops showing here and stops sending
          expiry alerts for this date. Nothing else changes. If the date changes later (a renewal
          that lapses again), it shows up again.
        </p>
        <Field label="Note (optional)" htmlFor="dismiss-note" help="For example: client cancelled, letting it lapse.">
          <Input
            id="dismiss-note"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function itemLabel(row: ExpirationRow): string {
  if (row.kind === 'asset-field') return `${row.assetName} (${row.fieldLabel})`;
  if (row.kind === 'domain') return `${row.hostname} (${row.source === 'tls' ? 'TLS certificate' : 'registration'})`;
  return `${row.passwordName} (${row.source === 'rotation' ? 'rotation' : 'expiry'})`;
}

function StatusPill({ row }: { row: ExpirationRow }) {
  if (row.dismissal) {
    return (
      <span title={row.dismissal.note ?? undefined}>
        <Tag tone="outline">Dismissed</Tag>
      </span>
    );
  }
  if (row.status === 'EXPIRED') {
    return (
      <Tag tone="danger">
        Expired
      </Tag>
    );
  }
  const urgent = row.daysUntil <= 7;
  return (
    <Tag tone={urgent ? 'warn' : 'outline'}>
      {row.daysUntil === 0 ? 'Today' : `${row.daysUntil}d`}
    </Tag>
  );
}

function ItemCell({
  row,
  asLink = true,
}: {
  row: ExpirationRow;
  asLink?: boolean;
}) {
  const body =
    row.kind === 'asset-field' ? (
      <>
        <LayoutSwatch icon={row.layoutIcon} color={row.layoutColor} size={22} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 500,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.assetName}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.layoutName} · {row.fieldLabel}
          </div>
        </div>
      </>
    ) : row.kind === 'domain' ? (
      <>
        <div
          style={{
            width: 22,
            height: 22,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 5,
            background: 'var(--info-soft)',
            color: 'var(--info)',
            flexShrink: 0,
          }}
        >
          <Icon.globe size={13} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 500,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.hostname}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
            }}
          >
            Domain · {row.source === 'registrar' ? 'Registration' : 'TLS cert'}
          </div>
        </div>
      </>
    ) : (
      <>
        <div
          style={{
            width: 22,
            height: 22,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 5,
            background: 'var(--warn-soft)',
            color: 'var(--warn)',
            flexShrink: 0,
          }}
        >
          <Icon.lock size={13} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 500,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.passwordName}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
            }}
          >
            Vault · {row.source === 'expiry' ? 'Hard expiry' : 'Rotation due'}
          </div>
        </div>
      </>
    );

  const containerStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: 'inherit',
    minWidth: 0,
    flex: 1,
  } as const;

  if (!asLink) {
    return <div style={containerStyle}>{body}</div>;
  }
  return (
    <Link href={detailHref(row)} style={containerStyle}>
      {body}
    </Link>
  );
}

function SourceCell({ row }: { row: ExpirationRow }) {
  if (row.kind === 'asset-field') {
    return <Tag tone="outline">{row.fieldLabel}</Tag>;
  }
  if (row.kind === 'domain') {
    return (
      <Tag tone="outline">
        {row.source === 'registrar' ? 'Registrar' : 'TLS certificate'}
      </Tag>
    );
  }
  return (
    <Tag tone="outline">
      {row.source === 'expiry' ? 'Password expiry' : 'Password rotation'}
    </Tag>
  );
}

function detailHref(row: ExpirationRow): string {
  if (row.kind === 'asset-field') {
    return `/admin/companies/${row.companyId}/assets/${row.assetId}`;
  }
  if (row.kind === 'domain') {
    return `/admin/companies/${row.companyId}/domains/${row.domainId}`;
  }
  return `/admin/companies/${row.companyId}/passwords/${row.passwordId}`;
}

function expiresFormat(row: ExpirationRow): 'DATE' | 'DATETIME' {
  if (row.kind === 'asset-field') return row.fieldType;
  return 'DATETIME';
}

function daysColor(n: number): string {
  if (n < 0) return 'var(--danger)';
  if (n <= 7) return 'var(--warn)';
  return 'var(--text-2)';
}

function ExpiresValue({ row }: { row: ExpirationRow }) {
  // Calendar-day asset fields (DATE) render in UTC so the stored day
  // never shifts across zones; timestamps (domains, passwords, DATETIME
  // fields) render in the viewer's timezone.
  return expiresFormat(row) === 'DATE' ? (
    <FormattedCalendarDate value={row.expiresAt} />
  ) : (
    <FormattedDateTime value={row.expiresAt} />
  );
}

function formatDays(n: number): string {
  if (n === 0) return 'today';
  if (n > 0) return `in ${n}d`;
  return `${Math.abs(n)}d ago`;
}

function rowKey(row: ExpirationRow): string {
  if (row.kind === 'asset-field') {
    return `af:${row.assetId}:${row.fieldId}`;
  }
  if (row.kind === 'domain') {
    return `dm:${row.domainId}:${row.source}`;
  }
  return `pw:${row.passwordId}:${row.source}`;
}
