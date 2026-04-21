'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../lib/api';
import type { LayoutSummary } from '../../../../lib/server-api';
import { Btn, Icon, LayoutSwatch, Tag, useToast } from '../../../../components/ui';
import { useIsMobile } from '../../../../lib/hooks/use-is-mobile';

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
 * refuses archived ids outright).
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
  const isMobile = useIsMobile();
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

  if (localOrder.length === 0) {
    return (
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
    );
  }

  if (isMobile) {
    return (
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
        {[...active, ...archived].map((l) => {
          const activeIdx = active.findIndex((a) => a.id === l.id);
          const isActiveRow = activeIdx >= 0;
          return (
            <li
              key={l.id}
              style={{
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: 12,
                background: 'var(--panel)',
                opacity: l.archivedAt ? 0.7 : 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
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
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {l.archivedAt ? (
                  <Tag tone="warn" dot>
                    archived
                  </Tag>
                ) : l.isActive ? (
                  <Tag tone="ok" dot>
                    active
                  </Tag>
                ) : (
                  <Tag tone="outline">inactive</Tag>
                )}
                <Tag tone="outline">
                  {l.fields.filter((f) => !f.archivedAt).length} fields
                </Tag>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--dim)',
                  }}
                >
                  {relative(l.updatedAt)}
                </span>
              </div>
              {canReorder && isActiveRow && (
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    borderTop: '1px solid var(--line)',
                    paddingTop: 8,
                  }}
                >
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
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--line)' }}>
          {[
            canReorder ? 'Order' : '',
            '',
            'Name',
            'Version',
            'Fields',
            'Updated',
            '',
          ].map((h, i) => (
            <th
              key={`${h}-${i}`}
              style={{
                textAlign: 'left',
                padding: '8px 12px',
                fontSize: 10.5,
                fontFamily: 'var(--font-mono)',
                color: 'var(--muted)',
                fontWeight: 400,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[...active, ...archived].map((l, i, rows) => {
          const activeIdx = active.findIndex((a) => a.id === l.id);
          const isActiveRow = activeIdx >= 0;
          return (
            <tr
              key={l.id}
              style={{
                borderBottom:
                  i === rows.length - 1 ? 'none' : '1px solid var(--line)',
                height: 44,
                opacity: l.archivedAt ? 0.55 : 1,
              }}
            >
              <td
                style={{
                  padding: '0 12px',
                  width: canReorder ? 72 : 0,
                  whiteSpace: 'nowrap',
                }}
              >
                {canReorder && isActiveRow && (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 2,
                    }}
                  >
                    <Btn
                      kind="ghost"
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
                )}
              </td>
              <td style={{ padding: '0 12px', width: 40 }}>
                <LayoutSwatch icon={l.icon} color={l.color} size={28} />
              </td>
              <td style={{ padding: '0 12px' }}>
                <Link
                  href={`/admin/layouts/${l.id}/edit`}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    color: 'inherit',
                  }}
                >
                  <span style={{ fontWeight: 500, fontSize: 13 }}>
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
                </Link>
              </td>
              <td
                style={{
                  padding: '0 12px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  width: 90,
                }}
              >
                v{l.version}
              </td>
              <td
                style={{
                  padding: '0 12px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  width: 110,
                }}
              >
                {l.fields.filter((f) => !f.archivedAt).length} fields
              </td>
              <td
                style={{
                  padding: '0 12px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--dim)',
                  width: 140,
                }}
              >
                {relative(l.updatedAt)}
              </td>
              <td style={{ padding: '0 12px', width: 80, textAlign: 'right' }}>
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
                  {canEdit ? 'Edit' : 'View'}
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
