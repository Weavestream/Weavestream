import { Chip } from '../../components/primitives';
import type { LayoutRecord } from './api';

/** The list's filter state, carried in the route search params. */
export interface AssetListFilter {
  layout?: string;
}

/**
 * The assets chip row: `All <total>` · one chip per layout that has
 * assets in this org.
 *
 * Layouts are GLOBAL, not org-scoped — an MSP with 25 layouts would
 * render 25 chips in every org where most are empty. `counts-by-layout`
 * (active assets per layout, this org) defines the relevant set for
 * free, so a chip appears only for a non-zero count — plus the
 * currently selected layout even at zero, so an active filter can
 * always be seen and cleared. Counts are active-only server-side,
 * which is exactly what the list shows (the archived view was cut).
 *
 * Counts may lag the layouts query; chips render without numbers until
 * they arrive rather than blocking the row. A chip tap re-queries
 * server-side (`layout` param) — client-side filtering can't work over
 * partially loaded pages.
 */
export function AssetFilterChips({
  layouts,
  counts,
  filter,
  onChange,
}: {
  layouts: LayoutRecord[];
  counts: Record<string, number> | undefined;
  filter: AssetListFilter;
  onChange: (next: AssetListFilter) => void;
}) {
  const visible = layouts.filter(
    (l) => (counts?.[l.id] ?? 0) > 0 || l.id === filter.layout,
  );
  const total = counts
    ? Object.values(counts).reduce((sum, n) => sum + n, 0)
    : null;
  return (
    <>
      <Chip active={!filter.layout} onClick={() => onChange({})}>
        {total !== null ? `All ${total}` : 'All'}
      </Chip>
      {visible.map((l) => {
        // The counts map omits zero-count layouts entirely — once it has
        // loaded, a missing entry IS zero (only the selected layout can
        // appear here at zero). Before it loads, chips render uncounted.
        const count = counts ? (counts[l.id] ?? 0) : undefined;
        return (
          <Chip
            key={l.id}
            active={filter.layout === l.id}
            onClick={() =>
              onChange(filter.layout === l.id ? {} : { layout: l.id })
            }
          >
            {count !== undefined ? `${l.name} ${count}` : l.name}
          </Chip>
        );
      })}
    </>
  );
}
