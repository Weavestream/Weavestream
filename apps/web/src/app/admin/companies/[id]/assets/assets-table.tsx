'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { BulkAssetResult } from '@weavestream/shared';
import type {
  AssetSummary,
  LayoutSummary,
} from '../../../../../lib/server-api';
import {
  Btn,
  DataTable,
  type DataColumn,
  Dialog,
  Icon,
  LayoutSwatch,
  MobileCardRow,
  Tag,
  useToast,
} from '../../../../../components/ui';
import { apiFetch } from '../../../../../lib/api';
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
  canManage,
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
  const toast = useToast();
  const [_pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(q);
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  // Bulk selection. `selectionMode` toggles the checkbox column and bulk
  // action bar; `selectedIds` persists across filter changes so a user
  // can refine filters without losing their selection. The bulk action
  // bar shows the full selection count even when some selected rows are
  // hidden by the current filters.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeText, setPurgeText] = useState('');

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

  // ----- Bulk selection helpers -----

  // Index for archived/non-archived classification of the *selection*
  // (not just visible rows) — needed for action-bar disabled states even
  // when filters hide some selected rows.
  const rowsById = useMemo(() => {
    const m = new Map<string, AssetSummary>();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);

  const selectedRows = useMemo(
    () =>
      Array.from(selectedIds)
        .map((id) => rowsById.get(id))
        .filter((r): r is AssetSummary => Boolean(r)),
    [selectedIds, rowsById],
  );

  const archivedSelectedCount = selectedRows.filter((r) => r.archivedAt).length;
  const activeSelectedCount = selectedRows.length - archivedSelectedCount;

  const visibleIds = useMemo(() => visibleRows.map((r) => r.id), [visibleRows]);
  const visibleSelectedCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected =
    visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && visibleSelectedCount < visibleIds.length;

  function toggleSelectionMode() {
    setSelectionMode((on) => {
      if (on) setSelectedIds(new Set());
      return !on;
    });
  }

  function toggleRowSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function runBulk(action: 'archive' | 'restore' | 'purge') {
    if (selectedIds.size === 0) return;
    setBulkPending(true);
    const ids = Array.from(selectedIds);
    const res = await apiFetch<BulkAssetResult>(
      `/companies/${companyId}/assets/bulk/${action}`,
      { method: 'POST', body: JSON.stringify({ ids }) },
    );
    setBulkPending(false);

    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | null;
      toast.push(
        problem?.detail ?? problem?.title ?? `Bulk ${action} failed.`,
        'danger',
      );
      return;
    }

    const { ok, failed } = res.data;
    const verb =
      action === 'archive'
        ? 'Archived'
        : action === 'restore'
          ? 'Restored'
          : 'Deleted';
    if (failed.length === 0) {
      toast.push(`${verb} ${ok.length} asset${ok.length === 1 ? '' : 's'}.`, 'ok');
      clearSelection();
    } else if (ok.length === 0) {
      toast.push(
        `Bulk ${action} failed for all ${failed.length} asset${failed.length === 1 ? '' : 's'}.`,
        'danger',
      );
    } else {
      toast.push(
        `${verb} ${ok.length}, ${failed.length} failed (${summariseFailures(failed)}).`,
        'warn',
      );
      // Keep failed ids selected so the operator can inspect / retry.
      setSelectedIds(new Set(failed.map((f) => f.id)));
    }
    setPurgeOpen(false);
    setPurgeText('');
    router.refresh();
  }

  const purgeConfirmReady = purgeText.trim().toLowerCase() === 'delete';

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

        {canManage && (
          <button
            type="button"
            onClick={toggleSelectionMode}
            title={selectionMode ? 'Exit selection mode' : 'Select multiple'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              padding: '0 10px',
              background: selectionMode ? 'var(--accent-soft)' : 'transparent',
              border: `1px solid ${selectionMode ? 'var(--accent-line)' : 'var(--line-2)'}`,
              borderRadius: 5,
              fontSize: 12,
              color: selectionMode ? 'var(--accent)' : 'var(--text-2)',
              cursor: 'pointer',
            }}
          >
            <Icon.checkSquare size={12} />
            {selectionMode ? 'Exit select' : 'Select'}
          </button>
        )}
      </div>

      {/* Bulk action bar */}
      {selectionMode && selectedIds.size > 0 && (
        <BulkActionBar
          totalSelected={selectedIds.size}
          activeSelected={activeSelectedCount}
          archivedSelected={archivedSelectedCount}
          pending={bulkPending}
          onArchive={() => runBulk('archive')}
          onRestore={() => runBulk('restore')}
          onPurge={() => {
            setPurgeText('');
            setPurgeOpen(true);
          }}
          onClear={clearSelection}
        />
      )}

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

      {/* Table / cards — `flex: 1; min-height: 0` so the DataTable's own
          fillHeight scroll region can claim the leftover viewport
          rather than the whole page scrolling under it. */}
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
            fillHeight
            columns={assetColumns({
              companyId,
              selectionMode,
              selectedIds,
              allVisibleSelected,
              someVisibleSelected,
              onToggleAllVisible: toggleSelectAllVisible,
              onToggleRow: toggleRowSelection,
            })}
            rows={visibleRows}
            renderMobileCard={(r) => (
              <AssetMobileBody
                row={r}
                companyId={companyId}
                selectionMode={selectionMode}
                selected={selectedIds.has(r.id)}
                onToggle={() => toggleRowSelection(r.id)}
              />
            )}
          />
        )}
      </div>

      <Dialog
        open={purgeOpen}
        onClose={() => !bulkPending && setPurgeOpen(false)}
        title={`Permanently delete ${selectedIds.size} asset${selectedIds.size === 1 ? '' : 's'}?`}
        footer={
          <>
            <Btn
              kind="ghost"
              onClick={() => setPurgeOpen(false)}
              disabled={bulkPending}
            >
              Cancel
            </Btn>
            <Btn
              kind="danger"
              loading={bulkPending}
              disabled={!purgeConfirmReady}
              onClick={() => runBulk('purge')}
            >
              Delete forever
            </Btn>
          </>
        }
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: 'var(--text-2)',
              lineHeight: 1.5,
            }}
          >
            <strong>{selectedIds.size}</strong> asset
            {selectedIds.size === 1 ? '' : 's'} will be permanently removed,
            including all field values, sync records, and relation links. Any
            embedded credentials are unlinked but preserved. This cannot be
            undone.
          </p>
          <label
            style={{
              fontSize: 11.5,
              fontFamily: 'var(--font-mono)',
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
            }}
          >
            Type &ldquo;delete&rdquo; to confirm
            <input
              autoFocus
              value={purgeText}
              onChange={(e) => setPurgeText(e.target.value)}
              placeholder="delete"
              style={{
                marginTop: 6,
                width: '100%',
                padding: '8px 10px',
                fontSize: 13,
                fontFamily: 'var(--font-mono)',
                background: 'var(--panel-2)',
                border: '1px solid var(--line-2)',
                borderRadius: 6,
                color: 'var(--text)',
              }}
            />
          </label>
        </div>
      </Dialog>
    </div>
  );
}

function BulkActionBar({
  totalSelected,
  activeSelected,
  archivedSelected,
  pending,
  onArchive,
  onRestore,
  onPurge,
  onClear,
}: {
  totalSelected: number;
  activeSelected: number;
  archivedSelected: number;
  pending: boolean;
  onArchive: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onClear: () => void;
}) {
  // Mixed-state rules: Archive only does work on non-archived rows;
  // Restore only does work on archived rows. Disable when there's nothing
  // to do for that action — but never block Permanently Delete since
  // bulk purge handles archived + non-archived alike.
  const canArchive = activeSelected > 0;
  const canRestore = archivedSelected > 0;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '8px 14px',
        background: 'var(--accent-soft)',
        borderBottom: '1px solid var(--accent-line)',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--accent)',
          fontWeight: 600,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
        }}
      >
        {totalSelected} selected
      </span>
      {(activeSelected > 0 || archivedSelected > 0) && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--muted)',
          }}
        >
          ({activeSelected} active, {archivedSelected} archived)
        </span>
      )}
      <span style={{ flex: 1 }} />
      <Btn
        kind="outline"
        size="sm"
        icon={Icon.archive}
        disabled={!canArchive || pending}
        onClick={onArchive}
      >
        Archive
      </Btn>
      <Btn
        kind="outline"
        size="sm"
        icon={Icon.check}
        disabled={!canRestore || pending}
        onClick={onRestore}
      >
        Restore
      </Btn>
      <Btn
        kind="danger"
        size="sm"
        icon={Icon.trash}
        disabled={pending}
        onClick={onPurge}
      >
        Delete forever
      </Btn>
      <Btn kind="ghost" size="sm" disabled={pending} onClick={onClear}>
        Clear
      </Btn>
    </div>
  );
}

function summariseFailures(
  failed: BulkAssetResult['failed'],
): string {
  // Compact "5 already_archived, 2 forbidden" — codes group naturally so
  // the user can act on the dominant cause without us listing every item.
  const counts = new Map<string, number>();
  for (const f of failed) {
    const key = f.code ?? 'error';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([code, n]) => `${n} ${code.replace(/_/g, ' ')}`)
    .join(', ');
}

function HeaderCheckbox({
  checked,
  indeterminate,
  onToggle,
}: {
  checked: boolean;
  indeterminate: boolean;
  onToggle: () => void;
}) {
  return (
    <Checkbox
      checked={checked}
      indeterminate={indeterminate}
      onChange={onToggle}
      ariaLabel={checked ? 'Deselect all visible' : 'Select all visible'}
    />
  );
}

function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  ariaLabel?: string;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onChange();
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange();
        }
      }}
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: 16,
        height: 16,
        borderRadius: 3,
        border: `1px solid ${checked || indeterminate ? 'var(--accent)' : 'var(--line-2)'}`,
        background:
          checked || indeterminate ? 'var(--accent)' : 'var(--panel-2)',
        color: 'var(--accent-ink)',
        cursor: 'pointer',
        transition: 'background-color 120ms ease, border-color 120ms ease',
      }}
    >
      {indeterminate ? (
        <span
          style={{
            width: 8,
            height: 2,
            background: 'var(--accent-ink)',
            borderRadius: 1,
          }}
        />
      ) : checked ? (
        <Icon.check size={10} />
      ) : null}
    </span>
  );
}

function assetColumns({
  companyId,
  selectionMode,
  selectedIds,
  allVisibleSelected,
  someVisibleSelected,
  onToggleAllVisible,
  onToggleRow,
}: {
  companyId: string;
  selectionMode: boolean;
  selectedIds: Set<string>;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  onToggleAllVisible: () => void;
  onToggleRow: (id: string) => void;
}): DataColumn<AssetSummary>[] {
  const selectColumn: DataColumn<AssetSummary> | null = selectionMode
    ? {
        id: '_select',
        header: (
          <HeaderCheckbox
            checked={allVisibleSelected}
            indeterminate={someVisibleSelected}
            onToggle={onToggleAllVisible}
          />
        ),
        width: 40,
        sortable: false,
        render: (r) => (
          <Checkbox
            checked={selectedIds.has(r.id)}
            onChange={() => onToggleRow(r.id)}
            ariaLabel={`Select ${r.name}`}
          />
        ),
      }
    : null;
  const baseColumns: DataColumn<AssetSummary>[] = [
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
      width: 180,
      sortValue: (r) =>
        r.syncSources.length > 0
          ? r.syncSources
              .map((s) => s.driver)
              .sort()
              .join(',')
          : r.externalSource ?? 'manual',
      render: (r) => {
        const drivers =
          r.syncSources.length > 0
            ? Array.from(new Set(r.syncSources.map((s) => s.driver)))
            : r.externalSource
              ? [r.externalSource]
              : [];
        if (drivers.length === 0) {
          return (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
              }}
            >
              manual
            </span>
          );
        }
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {drivers.map((d) => (
              <Tag key={d} tone="info">
                {d.toLowerCase()}
              </Tag>
            ))}
          </div>
        );
      },
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
  return selectColumn ? [selectColumn, ...baseColumns] : baseColumns;
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
  selectionMode,
  selected,
  onToggle,
}: {
  row: AssetSummary;
  companyId: string;
  selectionMode: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const primaryValue = primaryString(row);
  // In selection mode the card itself becomes a tap-to-select target
  // (no navigation). Out of selection mode we keep the original Link
  // behaviour so the typical flow — tap card → open detail — is intact.
  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    color: 'inherit',
    opacity: row.archivedAt ? 0.7 : 1,
  };
  const inner = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {selectionMode && (
          <Checkbox
            checked={selected}
            onChange={onToggle}
            ariaLabel={`Select ${row.name}`}
          />
        )}
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
        {!selectionMode && (
          <Icon.chevron size={12} style={{ color: 'var(--dim)' }} />
        )}
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
        {row.syncSources.length > 0 ? (
          Array.from(new Set(row.syncSources.map((s) => s.driver))).map((d) => (
            <Tag key={d} tone="info">
              {d.toLowerCase()}
            </Tag>
          ))
        ) : row.externalSource ? (
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
    </>
  );
  if (selectionMode) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.preventDefault();
          onToggle();
        }}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={{
          ...containerStyle,
          cursor: 'pointer',
          background: selected ? 'var(--accent-soft)' : undefined,
          borderRadius: 6,
          padding: selected ? 6 : undefined,
          margin: selected ? -6 : undefined,
        }}
      >
        {inner}
      </div>
    );
  }
  return (
    <Link
      href={`/admin/companies/${companyId}/assets/${row.id}`}
      style={containerStyle}
    >
      {inner}
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
