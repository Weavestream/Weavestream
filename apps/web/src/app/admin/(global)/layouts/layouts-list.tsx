'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../lib/api';
import type { LayoutSummary } from '../../../../lib/server-api';
import {
  Btn,
  DataTable,
  type DataColumn,
  Icon,
  LayoutSwatch,
  MobileCardRow,
  Tag,
  useToast,
} from '../../../../components/ui';
import { LayoutSettingsDialog } from './layout-settings-dialog';
import { LayoutArchiveDialog } from './layout-archive-dialog';
import { compactRelative as relative } from '../../../../lib/relative-time';

/**
 * Admin "Layouts" table rows. Presentation stays close to the original
 * server-rendered version; the only behavioural addition is the pair
 * of up/down buttons on each *active* layout row that reorder the
 * global sidebar position. Reordering is optimistic: the local list
 * reflows instantly and the server acknowledgement via `PATCH
 * /layouts/reorder` drives a `router.refresh()` to reseat the canonical
 * order. On error we revert and toast the message — no partial states
 * get left behind.
 *
 * Archived layouts are always rendered at the bottom and are never
 * part of the active ordering (the server-side reorder validator
 * refuses archived ids outright). Sorting is disabled here because the
 * canonical order is meaningful (it drives the sidebar) and the
 * up/down reorder buttons would confuse users if a transient sort were
 * shuffling rows around.
 */
export function LayoutsList({
  layouts,
  canEdit,
}: {
  layouts: LayoutSummary[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  // Open-dialog state lives on the list so row-level clicks can hand a
  // specific layout to a single shared dialog instance instead of each
  // row mounting its own.
  const [settingsFor, setSettingsFor] = useState<LayoutSummary | null>(null);
  const [archiveFor, setArchiveFor] = useState<LayoutSummary | null>(null);
  // Local mirror so drag/up-down feels instant. Kept in sync with
  // `layouts` via the `useMemo` key below — when the server-component
  // reseeds us (after `router.refresh()`), this collapses back to the
  // canonical ordering.
  const [localOrder, setLocalOrder] = useState<LayoutSummary[]>(layouts);
  // `layouts` identity changes whenever the server component re-renders
  // us (e.g. after a successful reorder triggers `router.refresh()`).
  // Re-seed the local mirror so we never drift from the canonical
  // ordering once the server has spoken.
  useEffect(() => {
    setLocalOrder(layouts);
  }, [layouts]);

  const active = localOrder.filter((l) => !l.archivedAt);
  const archived = localOrder.filter((l) => l.archivedAt);
  const orderedRows = useMemo(() => [...active, ...archived], [active, archived]);

  const canReorder = canEdit && active.length > 1;

  async function reorder(nextActive: LayoutSummary[]) {
    const previous = localOrder;
    // Keep archived rows parked at the bottom in whatever order they
    // arrived; the server never touches their position.
    setLocalOrder([...nextActive, ...archived]);
    startTransition(() => {
      (async () => {
        const res = await apiFetch<{ items: LayoutSummary[] }>(
          '/layouts/reorder',
          {
            method: 'PATCH',
            body: JSON.stringify({ orderedIds: nextActive.map((l) => l.id) }),
          },
        );
        if (!res.ok) {
          setLocalOrder(previous);
          const problem = res.problem as { message?: string; detail?: string } | undefined;
          toast.push(
            problem?.message ?? problem?.detail ?? 'Reorder failed',
            'danger',
          );
          return;
        }
        toast.push('Order updated', 'ok');
        router.refresh();
      })();
    });
  }

  function move(id: string, direction: -1 | 1) {
    const idx = active.findIndex((l) => l.id === id);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= active.length) return;
    const next = active.slice();
    const [row] = next.splice(idx, 1);
    next.splice(target, 0, row!);
    void reorder(next);
  }

  const dialogs = canEdit ? (
    <>
      {settingsFor && (
        <LayoutSettingsDialog
          layout={settingsFor}
          open
          onClose={() => setSettingsFor(null)}
        />
      )}
      {archiveFor && (
        <LayoutArchiveDialog
          layout={archiveFor}
          open
          onClose={() => setArchiveFor(null)}
        />
      )}
    </>
  ) : null;

  const columns: DataColumn<LayoutSummary>[] = [
    {
      id: 'name',
      header: 'Name',
      width: 320,
      render: (l) => (
        <Link
          href={`/admin/layouts/${l.id}/edit`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'inherit',
          }}
        >
          <LayoutSwatch icon={l.icon} color={l.color} size={28} />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 500, color: 'var(--text)' }}>
              {l.name}
              {l.archivedAt && (
                <Tag tone="warn" style={{ marginLeft: 8 }}>
                  archived
                </Tag>
              )}
              {!l.isActive && !l.archivedAt && (
                <Tag tone="outline" style={{ marginLeft: 8 }}>
                  inactive
                </Tag>
              )}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              /{l.slug}
            </span>
          </span>
        </Link>
      ),
    },
    {
      id: 'version',
      header: 'Version',
      width: 90,
      mono: true,
      render: (l) => `v${l.version}`,
    },
    {
      id: 'fields',
      header: 'Fields',
      width: 110,
      mono: true,
      render: (l) => `${l.fields.filter((f) => !f.archivedAt).length} fields`,
    },
    {
      id: 'updated',
      header: 'Updated',
      width: 140,
      mono: true,
      render: (l) => (
        <span style={{ color: 'var(--dim)' }}>{relative(l.updatedAt)}</span>
      ),
    },
  ];

  if (canReorder) {
    columns.unshift({
      id: 'order',
      header: 'Order',
      width: 96,
      align: 'center',
      render: (l) => {
        const activeIdx = active.findIndex((a) => a.id === l.id);
        const isActiveRow = activeIdx >= 0;
        if (!isActiveRow) return null;
        return (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <Btn
              kind="ghost"
              size="sm"
              onClick={() => move(l.id, -1)}
              disabled={activeIdx === 0 || pending}
              title="Move up"
              aria-label="Move up"
            >
              <span
                style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}
              >
                <Icon.chevronD size={11} />
              </span>
            </Btn>
            <Btn
              kind="ghost"
              size="sm"
              icon={Icon.chevronD}
              onClick={() => move(l.id, 1)}
              disabled={activeIdx === active.length - 1 || pending}
              title="Move down"
              aria-label="Move down"
            />
          </div>
        );
      },
    });
  }

  if (canEdit) {
    columns.push({
      id: 'actions',
      header: '',
      width: 260,
      align: 'right',
      render: (l) => (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            whiteSpace: 'nowrap',
          }}
        >
          <Btn
            kind="ghost"
            size="sm"
            icon={Icon.edit}
            onClick={() => router.push(`/admin/layouts/${l.id}/edit`)}
            title="Open builder"
          >
            Edit
          </Btn>
          {!l.archivedAt && (
            <Btn
              kind="ghost"
              size="sm"
              icon={Icon.gear}
              onClick={() => setSettingsFor(l)}
              title="Rename layout or change icon/color"
            >
              Rename
            </Btn>
          )}
          <Btn
            kind="ghost"
            size="sm"
            icon={l.archivedAt ? Icon.check : Icon.archive}
            onClick={() => setArchiveFor(l)}
            title={l.archivedAt ? 'Restore layout' : 'Archive layout'}
          >
            {l.archivedAt ? 'Restore' : 'Archive'}
          </Btn>
        </div>
      ),
    });
  } else {
    columns.push({
      id: 'view',
      header: '',
      width: 80,
      align: 'right',
      render: (l) => (
        <Link
          href={`/admin/layouts/${l.id}/edit`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11.5,
            color: 'var(--accent)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <Icon.edit size={11} />
          View
        </Link>
      ),
    });
  }

  if (localOrder.length === 0) {
    return (
      <>
        <div
          style={{
            padding: 32,
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          {canEdit
            ? 'No layouts yet — create the first to give assets a schema.'
            : 'No layouts defined yet. Ask a super-admin to create one.'}
        </div>
        {dialogs}
      </>
    );
  }

  return (
    <>
      {/* `flex: 1; min-height: 0` so the DataTable's own fillHeight
          scroll region can claim the leftover viewport rather than the
          whole page scrolling under it. Without this the reorder-pending
          dimmer would be an ordinary block and swallow the chain. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          opacity: pending ? 0.6 : 1,
          transition: 'opacity 120ms ease',
        }}
      >
        <DataTable
          fillHeight
          columns={columns}
          rows={orderedRows}
          disableSort
          // The reorder controls sit in front of the name, so pin both:
          // pinning only column 0 would scroll the row's identity out of
          // view and leave a pair of anonymous up/down buttons behind.
          stickyColumns={canReorder ? 2 : 1}
          renderMobileCard={(l) => {
            const activeIdx = active.findIndex((a) => a.id === l.id);
            const isActiveRow = activeIdx >= 0;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Link
                  href={`/admin/layouts/${l.id}/edit`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'inherit',
                  }}
                >
                  <LayoutSwatch icon={l.icon} color={l.color} size={28} />
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
                      {l.name}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--dim)',
                      }}
                    >
                      /{l.slug} · v{l.version}
                    </div>
                  </div>
                  <Icon.chevron size={12} style={{ color: 'var(--dim)' }} />
                </Link>
                <MobileCardRow label="Status">
                  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
                    {l.archivedAt ? (
                      <Tag tone="warn">
                        archived
                      </Tag>
                    ) : l.isActive ? (
                      <Tag tone="ok">
                        active
                      </Tag>
                    ) : (
                      <Tag tone="outline">inactive</Tag>
                    )}
                    <Tag tone="outline">
                      {l.fields.filter((f) => !f.archivedAt).length} fields
                    </Tag>
                  </span>
                </MobileCardRow>
                <MobileCardRow label="Updated" mono>
                  {relative(l.updatedAt)}
                </MobileCardRow>
                {canEdit && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      borderTop: '1px solid var(--line)',
                      paddingTop: 8,
                    }}
                  >
                    {canReorder && isActiveRow && (
                      <>
                        <Btn
                          kind="outline"
                          size="sm"
                          onClick={() => move(l.id, -1)}
                          disabled={activeIdx === 0 || pending}
                          title="Move up"
                          aria-label="Move up"
                        >
                          <span
                            style={{
                              display: 'inline-flex',
                              transform: 'rotate(180deg)',
                            }}
                          >
                            <Icon.chevronD size={11} />
                          </span>
                          Up
                        </Btn>
                        <Btn
                          kind="outline"
                          size="sm"
                          icon={Icon.chevronD}
                          onClick={() => move(l.id, 1)}
                          disabled={activeIdx === active.length - 1 || pending}
                          title="Move down"
                          aria-label="Move down"
                        >
                          Down
                        </Btn>
                      </>
                    )}
                    {!l.archivedAt && (
                      <Btn
                        kind="outline"
                        size="sm"
                        icon={Icon.edit}
                        onClick={() => setSettingsFor(l)}
                      >
                        Rename
                      </Btn>
                    )}
                    <Btn
                      kind={l.archivedAt ? 'primary' : 'outline'}
                      size="sm"
                      icon={l.archivedAt ? Icon.check : Icon.archive}
                      onClick={() => setArchiveFor(l)}
                      style={{ marginLeft: 'auto' }}
                    >
                      {l.archivedAt ? 'Restore' : 'Archive'}
                    </Btn>
                  </div>
                )}
              </div>
            );
          }}
        />
      </div>
      {dialogs}
    </>
  );
}
