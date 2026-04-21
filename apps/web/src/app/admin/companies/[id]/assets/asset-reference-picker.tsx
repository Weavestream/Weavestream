'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../../../../../lib/api';
import type { AssetSummary } from '../../../../../lib/server-api';
import { Icon } from '../../../../../components/ui';

/**
 * Picker for `ASSET_REFERENCE` field values. Fetches candidate assets
 * from `/companies/:companyId/assets?layout=<targetLayoutId>` — already
 * tenant-scoped server-side by the `asset.read` permission check — and
 * presents them as a searchable combobox.
 *
 * Supports single- and multi-select via the field's `multiple` option.
 * The currently edited asset (when in edit mode) is excluded from the
 * candidate list so a record can never reference itself. When a layout
 * template hasn't been configured with a `targetLayoutId` yet, the
 * picker renders a diagnostic placeholder instead of a blank dropdown.
 */

type Props = {
  companyId: string;
  /** UUID of the asset currently being edited (omit in create mode). */
  currentAssetId?: string;
  /** Target layout, sourced from the field's `options.targetLayoutId`. */
  targetLayoutId: string | null;
  multiple: boolean;
  /** String id (single mode) or string[] (multiple mode). null / "" = unset. */
  value: unknown;
  onChange: (next: string | string[] | null) => void;
  disabled?: boolean;
  /** Shared form control styling so the anchor matches other inputs. */
  controlStyle: CSSProperties;
};

type AssetRow = Pick<
  AssetSummary,
  'id' | 'name' | 'layoutName' | 'layoutIcon' | 'layoutColor' | 'archivedAt'
>;

const DEBOUNCE_MS = 180;
const PAGE_LIMIT = 50;

export function AssetReferencePicker({
  companyId,
  currentAssetId,
  targetLayoutId,
  multiple,
  value,
  onChange,
  disabled,
  controlStyle,
}: Props) {
  const selectedIds = useMemo<string[]>(() => {
    // Asset-reference values always round-trip through the API as an
    // array, even for single-target fields (see AssetReferenceStrategy
    // — persisted shape is always `string[]`). Accept a bare string too
    // so local `onChange` emissions from the single-select path are
    // reflected immediately before the next load.
    if (Array.isArray(value)) {
      const ids = (value as unknown[])
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      return multiple ? ids : ids.slice(0, 1);
    }
    if (typeof value === 'string' && value.length > 0) {
      return [value];
    }
    return [];
  }, [value, multiple]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [cache, setCache] = useState<Map<string, AssetRow>>(() => new Map());
  const [activeIndex, setActiveIndex] = useState(0);
  const [popoverRect, setPopoverRect] = useState<
    { left: number; top: number; width: number } | null
  >(null);

  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Fetch candidates when the picker opens or the query changes. Debounced
  // so every keystroke in the search box doesn't fan out a request.
  useEffect(() => {
    if (!open || !targetLayoutId) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      const params = new URLSearchParams({
        layout: targetLayoutId,
        limit: String(PAGE_LIMIT),
      });
      if (query.trim()) params.set('q', query.trim());
      const res = await apiFetch<{ items: AssetSummary[] }>(
        `/companies/${companyId}/assets?${params.toString()}`,
      );
      if (cancelled) return;
      const raw = (res.data?.items ?? []) as AssetRow[];
      const filtered = raw.filter((a) => a.id !== currentAssetId);
      setItems(filtered);
      setCache((cur) => {
        const next = new Map(cur);
        for (const a of filtered) next.set(a.id, a);
        return next;
      });
      setActiveIndex(0);
      setLoading(false);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, targetLayoutId, companyId, currentAssetId]);

  // Backfill the label cache for any already-selected ids that haven't
  // been seen in a search result yet (common after page load in edit
  // mode, where `value` is a list of raw uuids).
  const selectedKey = selectedIds.join(',');
  useEffect(() => {
    const missing = selectedIds.filter((id) => !cache.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const loaded = await Promise.all(
        missing.map((id) =>
          apiFetch<AssetSummary>(`/companies/${companyId}/assets/${id}`),
        ),
      );
      if (cancelled) return;
      setCache((cur) => {
        const next = new Map(cur);
        for (const r of loaded) if (r.data) next.set(r.data.id, r.data);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // selectedKey intentionally tracks id-list identity cheaply; `cache`
    // is read inside to decide which ids need hydrating, but including
    // it in deps would re-trigger this effect after every merge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, companyId]);

  // Anchor the popover under the trigger; re-measure on open + scroll.
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const measure = () => {
      const rect = anchorRef.current!.getBoundingClientRect();
      setPopoverRect({
        left: rect.left,
        top: rect.bottom + 4,
        width: Math.max(rect.width, 280),
      });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (!tgt) return;
      if (anchorRef.current?.contains(tgt)) return;
      if (popoverRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 0);
  }, [open]);

  const selectById = useCallback(
    (id: string) => {
      if (multiple) {
        const next = selectedIds.includes(id)
          ? selectedIds.filter((x) => x !== id)
          : [...selectedIds, id];
        onChange(next);
      } else {
        // Click-again-to-clear for single-select. Returns a bare string
        // on set; the API widens to a 1-element array on write.
        onChange(selectedIds[0] === id ? null : id);
        setOpen(false);
      }
    },
    [multiple, onChange, selectedIds],
  );

  const removeById = useCallback(
    (id: string) => {
      if (multiple) {
        onChange(selectedIds.filter((x) => x !== id));
      } else {
        onChange(null);
      }
    },
    [multiple, onChange, selectedIds],
  );

  const onAnchorKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPopoverKey = (e: React.KeyboardEvent) => {
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = items[activeIndex];
      if (row) selectById(row.id);
    }
  };

  // ── empty-state: field isn't configured yet ────────────────────
  if (!targetLayoutId) {
    return (
      <div
        style={{
          ...controlStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--warn)',
          fontSize: 12,
        }}
      >
        <Icon.warn size={12} />
        Field has no target layout. Open the layout template and pick one
        under the field inspector.
      </div>
    );
  }

  return (
    <>
      <div
        ref={anchorRef}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onAnchorKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          ...controlStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 8px',
          minHeight: 34,
          cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: 'left',
          flexWrap: 'wrap',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <Icon.link size={11} style={{ color: 'var(--dim)', flexShrink: 0 }} />
        {selectedIds.length === 0 ? (
          <span style={{ color: 'var(--dim)', fontSize: 12.5 }}>
            {multiple ? 'Pick one or more assets…' : 'Pick an asset…'}
          </span>
        ) : (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              flex: 1,
              minWidth: 0,
            }}
          >
            {selectedIds.map((id) => {
              const row = cache.get(id);
              return (
                <Chip
                  key={id}
                  label={row?.name ?? `${id.slice(0, 8)}…`}
                  archived={!!row?.archivedAt}
                  onRemove={
                    disabled
                      ? undefined
                      : (e) => {
                          e.stopPropagation();
                          removeById(id);
                        }
                  }
                />
              );
            })}
          </div>
        )}
        <span style={{ flex: 1 }} />
        <Icon.caret
          size={9}
          style={{
            color: 'var(--dim)',
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 140ms ease',
          }}
        />
      </div>

      {open && popoverRect && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popoverRef}
              role="listbox"
              onKeyDown={onPopoverKey}
              tabIndex={-1}
              style={{
                position: 'fixed',
                left: popoverRect.left,
                top: popoverRect.top,
                width: popoverRect.width,
                maxHeight: 360,
                background: 'var(--panel)',
                border: '1px solid var(--line-2)',
                borderRadius: 6,
                boxShadow: 'var(--shadow-2)',
                zIndex: 1000,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{
                  padding: 6,
                  borderBottom: '1px solid var(--line)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Icon.search size={12} style={{ color: 'var(--dim)' }} />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search assets by name or field"
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: 'var(--text)',
                    fontSize: 12.5,
                    fontFamily: 'inherit',
                  }}
                />
                {loading && (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      color: 'var(--dim)',
                    }}
                  >
                    loading…
                  </span>
                )}
              </div>
              <div
                style={{
                  overflow: 'auto',
                  maxHeight: 300,
                  padding: 4,
                }}
              >
                {!loading && items.length === 0 && (
                  <div
                    style={{
                      padding: '10px 12px',
                      color: 'var(--muted)',
                      fontSize: 12.5,
                    }}
                  >
                    {query.trim()
                      ? 'No assets match that search.'
                      : 'No assets of this type exist yet.'}
                  </div>
                )}
                {items.map((row, i) => {
                  const isSelected = selectedIds.includes(row.id);
                  const isActive = i === activeIndex;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => selectById(row.id)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 10px',
                        borderRadius: 4,
                        background: isActive
                          ? 'var(--panel-2)'
                          : isSelected
                            ? 'var(--accent-soft)'
                            : 'transparent',
                        border: 'none',
                        color: 'var(--text)',
                        fontSize: 12.5,
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span
                        style={{
                          width: 14,
                          display: 'inline-flex',
                          justifyContent: 'center',
                          color: isSelected
                            ? 'var(--accent)'
                            : 'transparent',
                        }}
                      >
                        <Icon.check size={11} />
                      </span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {row.name}
                        {row.archivedAt && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontFamily: 'var(--font-mono)',
                              fontSize: 10,
                              color: 'var(--dim)',
                            }}
                          >
                            (archived)
                          </span>
                        )}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10.5,
                          color: 'var(--dim)',
                        }}
                      >
                        {row.layoutName}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function Chip({
  label,
  archived,
  onRemove,
}: {
  label: string;
  archived?: boolean;
  onRemove?: (e: React.MouseEvent) => void;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        background: archived ? 'var(--panel-2)' : 'var(--accent-soft)',
        border: `1px solid ${archived ? 'var(--line)' : 'var(--accent-line)'}`,
        borderRadius: 3,
        fontSize: 11.5,
        color: archived ? 'var(--muted)' : 'var(--accent)',
        maxWidth: '100%',
      }}
    >
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 200,
        }}
      >
        {label}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'inherit',
          }}
        >
          <Icon.x size={10} />
        </button>
      )}
    </span>
  );
}
