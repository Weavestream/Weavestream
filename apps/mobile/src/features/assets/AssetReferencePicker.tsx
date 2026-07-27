import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Sheet } from '../../components/Sheet';
import { Hint } from '../../components/FieldBlock';
import { Button, Input, ListRow } from '../../components/primitives';
import { fetchAssetsPage, type LayoutFieldRecord } from './api';
import type { FieldEditorValue, ReferenceDraft } from './field-values';

/**
 * ASSET_REFERENCE editor: selected references as removable rows plus an
 * Add button opening a Sheet picker over the plain assets list endpoint
 * (`layout=<options.targetLayoutId>&q=` — the same source the desktop
 * picker uses; first page only, 50 rows, which search narrows).
 *
 * A field without a configured `targetLayoutId` renders a diagnostic —
 * never a silently-empty picker. The current asset is excluded from
 * candidates (no self-reference). Missing sidecar names render the
 * `id… (missing)` convention so broken data stays visible.
 */

const DEBOUNCE_MS = 180;

export function AssetReferencePicker({
  field,
  id,
  companyId,
  currentAssetId,
  value,
  onChange,
  disabled,
}: {
  field: LayoutFieldRecord;
  /** FieldBlock label target — lands on the primary picker button. */
  id: string;
  companyId: string | null;
  /** The asset being edited (undefined on create) — excluded from candidates. */
  currentAssetId?: string;
  value: Extract<FieldEditorValue, { kind: 'reference' }>;
  onChange: (next: FieldEditorValue) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const multiple = field.options['multiple'] === true;
  const targetLayoutId =
    typeof field.options['targetLayoutId'] === 'string'
      ? (field.options['targetLayoutId'] as string)
      : null;

  if (targetLayoutId === null) {
    return (
      <Hint>
        This field’s target layout isn’t configured — edit it on desktop.
      </Hint>
    );
  }

  const removeAt = (index: number) =>
    onChange({ kind: 'reference', refs: value.refs.filter((_, i) => i !== index) });

  const addRef = (ref: ReferenceDraft) => {
    if (multiple) {
      if (!value.refs.some((r) => r.id === ref.id)) {
        onChange({ kind: 'reference', refs: [...value.refs, ref] });
      }
    } else {
      onChange({ kind: 'reference', refs: [ref] });
      setOpen(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.75">
      {value.refs.length > 0 && (
        <div className="flex flex-col overflow-hidden rounded-field border border-line bg-surface">
          {value.refs.map((ref, i) => (
            <span
              key={ref.id}
              className={
                'flex min-h-tap items-center gap-2 px-4 py-1' +
                (i > 0 ? ' border-t border-line' : '')
              }
            >
              <span
                className={
                  'min-w-0 flex-1 truncate text-body ' +
                  (ref.name === null
                    ? 'font-mono text-[13px] text-muted'
                    : ref.archived
                      ? 'text-muted line-through'
                      : 'text-text')
                }
              >
                {ref.name ?? `${ref.id.slice(0, 8)}… (missing)`}
              </span>
              {ref.archived && (
                <span className="shrink-0 text-[12px] text-muted">archived</span>
              )}
              <button
                type="button"
                aria-label={`Remove ${ref.name ?? 'reference'}`}
                disabled={disabled}
                onClick={() => removeAt(i)}
                className="flex shrink-0 items-center justify-center text-muted active:text-text"
              >
                <Icon name="close" size={18} />
              </button>
            </span>
          ))}
        </div>
      )}

      <Button
        id={id}
        kind="secondary"
        icon="search"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {value.refs.length === 0 ? 'Choose…' : multiple ? 'Add another' : 'Replace'}
      </Button>

      <ReferencePickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title={`Choose ${field.name}`}
        companyId={companyId}
        targetLayoutId={targetLayoutId}
        currentAssetId={currentAssetId}
        multiple={multiple}
        selectedIds={new Set(value.refs.map((r) => r.id))}
        onPick={addRef}
        onRemoveId={(id) =>
          onChange({ kind: 'reference', refs: value.refs.filter((r) => r.id !== id) })
        }
      />
    </div>
  );
}

function ReferencePickerSheet({
  open,
  onClose,
  title,
  companyId,
  targetLayoutId,
  currentAssetId,
  multiple,
  selectedIds,
  onPick,
  onRemoveId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  companyId: string | null;
  targetLayoutId: string;
  currentAssetId?: string;
  multiple: boolean;
  selectedIds: ReadonlySet<string>;
  onPick: (ref: ReferenceDraft) => void;
  onRemoveId: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const resultsQuery = useQuery({
    queryKey: ['assets', companyId, 'picker', targetLayoutId, debounced] as const,
    queryFn: ({ signal }) =>
      fetchAssetsPage(companyId!, {
        layoutId: targetLayoutId,
        q: debounced || undefined,
        signal,
      }),
    enabled: open && companyId !== null,
  });

  const candidates = (resultsQuery.data?.items ?? []).filter(
    (a) => a.id !== currentAssetId,
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        multiple ? (
          <Button kind="primary" onClick={onClose}>
            Done
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2.5">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name…"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />

        {resultsQuery.isPending && open && (
          <p className="py-2 text-center text-meta text-muted">Loading…</p>
        )}
        {resultsQuery.error != null && (
          <p className="py-2 text-center text-meta text-danger">
            Couldn’t search assets. Try again.
          </p>
        )}
        {resultsQuery.data && candidates.length === 0 && (
          <p className="py-2 text-center text-meta text-muted">
            {debounced ? 'No assets match.' : 'No assets in the target layout.'}
          </p>
        )}

        {candidates.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {candidates.map((a) => {
              const selected = selectedIds.has(a.id);
              return (
                <ListRow
                  key={a.id}
                  title={a.name}
                  metaFont="sans"
                  meta={a.archivedAt !== null ? `${a.layoutName} · archived` : a.layoutName}
                  minHeight="row"
                  selected={selected}
                  trailing={
                    selected ? (
                      <Icon
                        name="check_circle"
                        size={22}
                        className="shrink-0 text-accent"
                      />
                    ) : undefined
                  }
                  onClick={() => {
                    if (selected) {
                      if (multiple) onRemoveId(a.id);
                      return;
                    }
                    onPick({
                      id: a.id,
                      name: a.name,
                      archived: a.archivedAt !== null,
                    });
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </Sheet>
  );
}
