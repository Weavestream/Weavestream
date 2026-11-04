import type { ReactNode } from 'react';
import { Icon } from './icon';

export type FilterChipItem = {
  /** Stable React key, unique within the row. */
  key: string;
  label: ReactNode;
  onRemove: () => void;
};

/**
 * The row of removable filter pills under a list's filter bar, with a
 * "clear all" control. Shared by the asset lists so every active filter
 * (search terms, layout, tag, archived, field filters) reads and clears
 * the same way. Renders nothing when no filter is active.
 */
export function FilterChipRow({
  chips,
  onClearAll,
}: {
  chips: FilterChipItem[];
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;
  return (
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
      {chips.map((chip) => (
        <FilterChip key={chip.key} onRemove={chip.onRemove}>
          {chip.label}
        </FilterChip>
      ))}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onClearAll}
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
  );
}

export function FilterChip({
  children,
  onRemove,
}: {
  children: ReactNode;
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
