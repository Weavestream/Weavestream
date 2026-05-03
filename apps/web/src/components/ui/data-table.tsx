'use client';

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { useIsMobile } from '../../lib/hooks/use-is-mobile';

/**
 * Guard against XSS via attacker-controlled `rowHref` return values.
 *
 * `DataTable` navigates on row click using the string returned from the
 * caller-provided `rowHref`. If that ever evaluated to something like
 * `javascript:...`, assigning it to `window.location.href` (or handing it
 * to the router) would execute script in the victim's origin.
 *
 * We therefore only accept same-origin, relative paths:
 *   - must start with a single `/`
 *   - must NOT start with `//` (protocol-relative → cross-origin)
 *   - must NOT start with `/\` (some browsers normalize backslashes to `/`,
 *     so `/\\evil.com` can be treated as protocol-relative)
 *
 * Anything else (absolute URLs, `javascript:`, `data:`, `vbscript:`, empty
 * strings, etc.) is rejected and the click is ignored.
 */
function isSafeInternalHref(href: string | undefined): href is string {
  if (typeof href !== 'string' || href.length === 0) return false;
  if (href[0] !== '/') return false;
  if (href[1] === '/' || href[1] === '\\') return false;
  return true;
}

/**
 * Comparable values supported by `DataColumn.sortValue`. The comparator
 * handles `null`/`undefined` (always sorted last), numbers, booleans,
 * Date instances, and strings (locale-aware, numeric-aware).
 */
export type SortValue = string | number | boolean | Date | null | undefined;
export type SortDirection = 'asc' | 'desc';
export type SortState = { columnId: string; direction: SortDirection };

export type DataColumn<T> = {
  id: string;
  header: ReactNode;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
  render: (row: T) => ReactNode;
  /**
   * Returns the comparable value for this column. Provide it to make the
   * column sortable; omit it (or set `sortable: false`) for action /
   * decorative columns.
   */
  sortValue?: (row: T) => SortValue;
  /**
   * Force a column to be (un)sortable. Defaults to `true` when
   * `sortValue` is defined and `false` otherwise.
   */
  sortable?: boolean;
};

/**
 * Small helper for mobile card bodies. Renders a label/value row with
 * the same mono label styling used by admin inspector panels, so each
 * `renderMobileCard` implementation stays consistent without a local
 * layout component. Value can be any ReactNode (chips, relative times,
 * user-picker display, …).
 */
export function MobileCardRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        padding: '3px 0',
        fontSize: 12.5,
        color: 'var(--text-2)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: 'var(--dim)',
          minWidth: 72,
        }}
      >
        {label}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          wordBreak: 'break-word',
        }}
      >
        {children}
      </div>
    </div>
  );
}

const cellBase: CSSProperties = {
  padding: '10px 12px',
  fontSize: 12.5,
  color: 'var(--text-2)',
  borderBottom: '1px solid var(--line)',
  verticalAlign: 'middle',
};

const headCellBase: CSSProperties = {
  ...cellBase,
  textAlign: 'left',
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  background: 'var(--panel)',
  borderBottom: '1px solid var(--line)',
  position: 'sticky',
  top: 0,
  zIndex: 1,
};

/**
 * Fallback width used for the first column when `stickyFirstColumn` is
 * enabled but the consumer didn't set `width`. A sticky column without a
 * defined width can collapse under `tableLayout: fixed`, so we lock in a
 * sensible default and warn in dev so the consumer can pick a better one.
 */
const STICKY_FALLBACK_WIDTH = 220;

function isNil(v: SortValue): v is null | undefined {
  return v === null || v === undefined;
}

/**
 * Stable comparator for `SortValue`s. Nulls/undefined go last regardless
 * of direction (callers pass `direction` separately). Mixed-type
 * comparisons fall back to locale-aware string compare so a column that
 * sometimes returns numbers and sometimes strings still produces a
 * deterministic order.
 */
function compareValues(a: SortValue, b: SortValue): number {
  if (isNil(a) && isNil(b)) return 0;
  if (isNil(a)) return 1;
  if (isNil(b)) return -1;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return 0;
    if (Number.isNaN(a)) return 1;
    if (Number.isNaN(b)) return -1;
    return a - b;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function SortIndicator({ direction }: { direction: SortDirection | null }) {
  // 12px chevrons inlined so DataTable doesn't pull in lucide just for
  // two glyphs. Stroke matches the rest of `Icon` (1.5).
  if (direction === 'asc') {
    return (
      <svg
        width={11}
        height={11}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0, opacity: 0.95 }}
      >
        <path d="M4 10l4-4 4 4" />
      </svg>
    );
  }
  if (direction === 'desc') {
    return (
      <svg
        width={11}
        height={11}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0, opacity: 0.95 }}
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    );
  }
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, opacity: 0.45 }}
    >
      <path d="M4 6.5l4-3 4 3" />
      <path d="M4 9.5l4 3 4-3" />
    </svg>
  );
}

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  empty,
  rowHref,
  onRowClick,
  renderMobileCard,
  defaultSort,
  disableSort = false,
  stickyFirstColumn = true,
  fillHeight = false,
}: {
  columns: DataColumn<T>[];
  rows: T[];
  empty?: ReactNode;
  rowHref?: (row: T) => string;
  // Phase 9a: lets callers open a detail drawer from a click without
  // giving up the pointer-cursor + hover affordance baked in here.
  // Ignored when `rowHref` is also set (links win).
  onRowClick?: (row: T) => void;
  /**
   * Phase 9c: render a per-row card on viewports below Tailwind's
   * `md` breakpoint. When defined, the table body is replaced with a
   * vertical list of cards (one per row) so data-dense tables stay
   * legible on phones. `rowHref`/`onRowClick` still fire from a click
   * on the card wrapper.
   */
  renderMobileCard?: (row: T) => ReactNode;
  /**
   * Initial sort applied on mount and used as the "reset" target when
   * the user cycles a sortable header back to its default state. If a
   * user sorts a different column, clicking that column twice (asc →
   * desc) and once more snaps the table back to this sort.
   */
  defaultSort?: { columnId: string; direction?: SortDirection };
  /**
   * Disables the click-to-sort affordance entirely. Use for tables
   * whose row order comes from the server (audit log, expirations,
   * paginated lists) where a client-side sort would only reorder the
   * current page and feel inconsistent across page boundaries.
   */
  disableSort?: boolean;
  /**
   * When true (default), the leftmost column is pinned in place during
   * horizontal scroll. The first column should have a `width` set; if
   * it doesn't, a 220 px fallback is used and a dev warning is logged.
   */
  stickyFirstColumn?: boolean;
  /**
   * Stretch the table wrapper to fill the available height of a flex
   * parent and scroll the body internally. Combined with the existing
   * sticky `<thead>`, this keeps column headers in view while the row
   * area scrolls — and prevents the surrounding page chrome
   * (PageHeader, filter bar, bulk action bar) from being pushed
   * off-screen when the table grows tall. Requires the parent chain
   * (`PageBody` → `Panel fillHeight` → table container) to be a
   * properly-sized flex column with `min-height: 0`.
   */
  fillHeight?: boolean;
}) {
  const isMobile = useIsMobile();
  const router = useRouter();

  const initialSort: SortState | null = useMemo(() => {
    if (disableSort || !defaultSort) return null;
    return {
      columnId: defaultSort.columnId,
      direction: defaultSort.direction ?? 'asc',
    };
  }, [disableSort, defaultSort]);

  const [sortState, setSortState] = useState<SortState | null>(initialSort);

  const isColumnSortable = useCallback(
    (c: DataColumn<T>) => {
      if (disableSort) return false;
      return c.sortable ?? Boolean(c.sortValue);
    },
    [disableSort],
  );

  const sortableColumns = useMemo(
    () => columns.filter(isColumnSortable),
    [columns, isColumnSortable],
  );

  const sortedRows = useMemo(() => {
    if (!sortState) return rows;
    const col = columns.find((c) => c.id === sortState.columnId);
    if (!col || !col.sortValue) return rows;
    const sv = col.sortValue;
    const dir = sortState.direction === 'asc' ? 1 : -1;
    // Stable sort: tag with the original index and use it as a tiebreaker
    // so equal sortValues keep their incoming order across re-sorts.
    return rows
      .map((row, idx) => ({ row, idx }))
      .sort((a, b) => {
        const cmp = compareValues(sv(a.row), sv(b.row));
        if (cmp !== 0) return cmp * dir;
        return a.idx - b.idx;
      })
      .map((p) => p.row);
  }, [rows, columns, sortState]);

  const handleHeaderClick = useCallback(
    (columnId: string) => {
      setSortState((current) => {
        if (!current || current.columnId !== columnId) {
          return { columnId, direction: 'asc' };
        }
        if (current.direction === 'asc') {
          return { columnId, direction: 'desc' };
        }
        // current.direction === 'desc' → reset to defaultSort if any,
        // otherwise unsorted.
        if (initialSort && initialSort.columnId !== columnId) {
          return initialSort;
        }
        return null;
      });
    },
    [initialSort],
  );

  // Tracks whether the table's horizontal scroll container has been
  // scrolled past its left edge. Drives the right-edge shadow on the
  // sticky first column so the affordance only appears when there's
  // hidden content to the left.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const handleScroll = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const next = el.scrollLeft > 0 ? 'true' : 'false';
    if (el.dataset.scrolled !== next) el.dataset.scrolled = next;
  }, []);

  // User-resizable first column. We only resize the sticky one because
  // its width is the only one that materially affects the available
  // space for trailing columns (those collapse via `tableLayout: fixed`
  // already). The override lives in component state — not persisted —
  // so it resets on navigation, matching the no-localStorage policy
  // documented in the plan's "out of scope" section.
  const firstCol = columns[0];
  const firstColBaseWidth =
    firstCol && typeof firstCol.width === 'number'
      ? firstCol.width
      : firstCol && firstCol.width === undefined && stickyFirstColumn
        ? STICKY_FALLBACK_WIDTH
        : null;
  const [firstColOverride, setFirstColOverride] = useState<number | null>(null);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  const onResizeMove = useCallback((e: MouseEvent) => {
    const s = resizeStateRef.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    const next = Math.max(80, Math.min(800, s.startWidth + dx));
    setFirstColOverride(next);
  }, []);

  const onResizeEnd = useCallback(() => {
    resizeStateRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
  }, [onResizeMove]);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (firstColBaseWidth == null) return;
      e.preventDefault();
      e.stopPropagation();
      resizeStateRef.current = {
        startX: e.clientX,
        startWidth: firstColOverride ?? firstColBaseWidth,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onResizeMove);
      document.addEventListener('mouseup', onResizeEnd);
    },
    [firstColBaseWidth, firstColOverride, onResizeMove, onResizeEnd],
  );

  const onResizeDouble = useCallback(() => {
    setFirstColOverride(null);
  }, []);

  // Stop dragging if the table unmounts mid-drag.
  useEffect(() => {
    return () => {
      if (resizeStateRef.current) onResizeEnd();
    };
  }, [onResizeEnd]);

  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 32,
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 12.5,
        }}
      >
        {empty ?? 'Nothing here yet.'}
      </div>
    );
  }

  if (isMobile && renderMobileCard) {
    return (
      <div
        style={
          fillHeight
            ? {
                display: 'flex',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
              }
            : undefined
        }
      >
        {sortableColumns.length > 0 ? (
          <MobileSortBar
            columns={sortableColumns}
            value={sortState}
            onChange={setSortState}
          />
        ) : null}
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            ...(fillHeight
              ? { flex: 1, minHeight: 0, overflowY: 'auto' }
              : null),
          }}
        >
          {sortedRows.map((row) => {
            const rawHref = rowHref?.(row);
            const safeHref = isSafeInternalHref(rawHref) ? rawHref : undefined;
            const clickable = Boolean(safeHref || onRowClick);
            return (
              <li
                key={row.id}
                onClick={(e) => {
                  if (!clickable) return;
                  if (
                    e.target instanceof HTMLElement &&
                    e.target.closest('a, button, [role="button"]')
                  ) {
                    return;
                  }
                  if (safeHref) {
                    router.push(safeHref);
                  } else if (onRowClick) {
                    onRowClick(row);
                  }
                }}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: 12,
                  background: 'var(--panel)',
                  cursor: clickable ? 'pointer' : 'default',
                  transition: 'background-color 120ms ease',
                }}
              >
                {renderMobileCard(row)}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      onScroll={handleScroll}
      data-scrolled="false"
      className="dt-wrap"
      style={
        fillHeight
          ? {
              overflowX: 'auto',
              overflowY: 'auto',
              flex: 1,
              minHeight: 0,
            }
          : { overflowX: 'auto' }
      }
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'auto',
        }}
      >
        <thead>
          <tr>
            {columns.map((c, idx) => {
              const sortable = isColumnSortable(c);
              const isSticky = stickyFirstColumn && idx === 0;
              const isSorted = sortState?.columnId === c.id;
              const ariaSort: 'none' | 'ascending' | 'descending' = isSorted
                ? sortState!.direction === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none';
              const baseStickyWidth =
                isSticky && c.width === undefined
                  ? STICKY_FALLBACK_WIDTH
                  : c.width;
              const effectiveWidth =
                isSticky && firstColOverride != null
                  ? firstColOverride
                  : baseStickyWidth;
              if (
                isSticky &&
                c.width === undefined &&
                process.env.NODE_ENV !== 'production'
              ) {
                console.warn(
                  `[DataTable] First column "${c.id}" has no width but stickyFirstColumn is enabled; falling back to ${STICKY_FALLBACK_WIDTH}px.`,
                );
              }
              const stickyStyle: CSSProperties = isSticky
                ? {
                    position: 'sticky',
                    left: 0,
                    zIndex: 2,
                    background: 'var(--panel)',
                  }
                : {};
              const showResizeHandle =
                isSticky && firstColBaseWidth != null;
              // Sizing strategy: with `tableLayout: 'auto'`, columns grow
              // to fit content. The sticky first column must remain a
              // fixed width (so the resize handle, shadow, and left-edge
              // alignment behave predictably), so we lock it via
              // width+min+max. Other columns use `minWidth` only — their
              // declared `width` acts as a sensible starting size that
              // content can grow.
              const widthStyle: CSSProperties = isSticky
                ? {
                    width: effectiveWidth,
                    minWidth: effectiveWidth,
                    maxWidth: effectiveWidth,
                  }
                : c.width !== undefined
                  ? { minWidth: c.width }
                  : {};
              return (
                <th
                  key={c.id}
                  className={isSticky ? 'dt-sticky dt-sticky-head' : undefined}
                  aria-sort={sortable ? ariaSort : undefined}
                  style={{
                    ...headCellBase,
                    ...widthStyle,
                    textAlign: c.align ?? 'left',
                    position: isSticky ? 'sticky' : 'relative',
                    ...stickyStyle,
                  }}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => handleHeaderClick(c.id)}
                      className="dt-sort-btn"
                      style={{
                        all: 'unset',
                        boxSizing: 'border-box',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        width: '100%',
                        justifyContent:
                          c.align === 'right'
                            ? 'flex-end'
                            : c.align === 'center'
                              ? 'center'
                              : 'flex-start',
                        color: isSorted ? 'var(--text-2)' : 'inherit',
                        font: 'inherit',
                        letterSpacing: 'inherit',
                        textTransform: 'inherit',
                      }}
                    >
                      <span>{c.header}</span>
                      <SortIndicator
                        direction={isSorted ? sortState!.direction : null}
                      />
                    </button>
                  ) : (
                    c.header
                  )}
                  {showResizeHandle ? (
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize column"
                      title="Drag to resize · double-click to reset"
                      onMouseDown={onResizeStart}
                      onDoubleClick={onResizeDouble}
                      className="dt-resize-handle"
                    />
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const rawHref = rowHref?.(row);
            const safeHref = isSafeInternalHref(rawHref) ? rawHref : undefined;
            const clickable = Boolean(safeHref || onRowClick);
            return (
              <tr
                key={row.id}
                className={clickable ? 'dt-row-clickable' : undefined}
                onClick={(e) => {
                  if (!clickable) return;
                  if (
                    e.target instanceof HTMLElement &&
                    e.target.closest('a, button, [role="button"]')
                  ) {
                    return;
                  }
                  if (safeHref) {
                    router.push(safeHref);
                  } else if (onRowClick) {
                    onRowClick(row);
                  }
                }}
              >
                {columns.map((c, idx) => {
                  const isSticky = stickyFirstColumn && idx === 0;
                  const baseStickyWidth =
                    isSticky && c.width === undefined
                      ? STICKY_FALLBACK_WIDTH
                      : c.width;
                  const effectiveWidth =
                    isSticky && firstColOverride != null
                      ? firstColOverride
                      : baseStickyWidth;
                  const stickyStyle: CSSProperties = isSticky
                    ? {
                        position: 'sticky',
                        left: 0,
                        zIndex: 1,
                        background: 'var(--panel)',
                      }
                    : {};
                  const widthStyle: CSSProperties = isSticky
                    ? {
                        width: effectiveWidth,
                        minWidth: effectiveWidth,
                        maxWidth: effectiveWidth,
                      }
                    : c.width !== undefined
                      ? { minWidth: c.width }
                      : {};
                  return (
                    <td
                      key={c.id}
                      className={isSticky ? 'dt-sticky' : undefined}
                      style={{
                        ...cellBase,
                        textAlign: c.align ?? 'left',
                        fontFamily: c.mono ? 'var(--font-mono)' : undefined,
                        ...widthStyle,
                        ...stickyStyle,
                      }}
                    >
                      {c.render(row)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MobileSortBar<T>({
  columns,
  value,
  onChange,
}: {
  columns: DataColumn<T>[];
  value: SortState | null;
  onChange: (next: SortState | null) => void;
}) {
  const currentColumnId = value?.columnId ?? '';
  const currentDirection = value?.direction ?? 'asc';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px 0',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: 'var(--muted)',
      }}
    >
      <span>Sort</span>
      <select
        value={currentColumnId}
        onChange={(e) => {
          const next = e.target.value;
          if (!next) {
            onChange(null);
            return;
          }
          onChange({ columnId: next, direction: currentDirection });
        }}
        style={{
          flex: 1,
          minWidth: 0,
          padding: '6px 8px',
          background: 'var(--panel)',
          color: 'var(--text)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          fontFamily: 'inherit',
          fontSize: 11.5,
          textTransform: 'none',
          letterSpacing: 0,
        }}
      >
        <option value="">None</option>
        {columns.map((c) => (
          <option key={c.id} value={c.id}>
            {typeof c.header === 'string' ? c.header : c.id}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!currentColumnId}
        onClick={() =>
          onChange(
            currentColumnId
              ? {
                  columnId: currentColumnId,
                  direction: currentDirection === 'asc' ? 'desc' : 'asc',
                }
              : null,
          )
        }
        aria-label={`Sort ${currentDirection === 'asc' ? 'descending' : 'ascending'}`}
        style={{
          all: 'unset',
          boxSizing: 'border-box',
          padding: '6px 8px',
          border: '1px solid var(--line)',
          borderRadius: 6,
          background: 'var(--panel)',
          color: currentColumnId ? 'var(--text-2)' : 'var(--dim)',
          cursor: currentColumnId ? 'pointer' : 'default',
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        <SortIndicator direction={currentColumnId ? currentDirection : null} />
      </button>
    </div>
  );
}
