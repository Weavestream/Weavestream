import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { Avatar, Title } from './primitives';
import type { Org } from '../lib/org-scope';

/**
 * The header block from shell 2b: org row, then title row, then an
 * optional filter row.
 *
 * 2b's defining trade is that **search lives in the header, not the
 * content** — which buys back a full row and is why the passwords list
 * shows a usable number of cards above the fold. The button renders only
 * when `onSearch` is provided, keeping this component presentational.
 */
export function ScreenHeader({
  org,
  onOpenOrgSheet,
  title,
  action,
  filters,
  onSearch,
}: {
  org: Org | null;
  onOpenOrgSheet: () => void;
  title: string;
  /** Right-hand control on the title row (the handoff's "New" button). */
  action?: ReactNode;
  /** Filter-chip row. Scrolls horizontally when it overflows. */
  filters?: ReactNode;
  /** Opens the search screen — 2b's header search button. */
  onSearch?: () => void;
}) {
  return (
    // `max-w-page` on the SAME element as the padding — the one shared
    // column pattern (see tokens.css) that keeps every screen's content
    // edges identical at any window width.
    <header className="mx-auto flex w-full max-w-page shrink-0 flex-col gap-3.5 px-4 pb-3 pt-edge-t">
      <div className="flex items-center justify-between gap-2">
        {/* The whole group is the tap target, per the handoff. */}
        <button
          type="button"
          onClick={onOpenOrgSheet}
          aria-haspopup="dialog"
          className="-ml-1 flex min-w-0 items-center gap-2 rounded-btn px-1 py-1 active:bg-panel-2"
        >
          {org && (
            <Avatar initials={org.initials} size={28} tone="accent" />
          )}
          <span className="truncate text-org-name font-semibold text-text">
            {org?.name ?? 'No organization'}
          </span>
          <Icon name="expand_more" size={20} className="text-muted" />
        </button>

        {onSearch && (
          // 40×40 visually per the handoff; the 44px tap floor from
          // globals.css still applies, so the two numbers deliberately
          // disagree (same trade as IconButton).
          <button
            type="button"
            onClick={onSearch}
            aria-label="Search"
            className={
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-btn ' +
              'border border-line bg-surface text-text-2 active:bg-panel-2'
            }
          >
            <Icon name="search" size={22} />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Title>{title}</Title>
        {action}
      </div>

      {filters && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4">{filters}</div>
      )}
    </header>
  );
}
