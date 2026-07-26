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
 * shows a usable number of cards above the fold. Phase 1 does not render
 * that button: the screen it opens is Phase 3, and a control that opens
 * nothing is worse than an absent one. The slot is here, commented, so
 * the trade isn't quietly lost.
 */
export function ScreenHeader({
  org,
  onOpenOrgSheet,
  title,
  action,
  filters,
}: {
  org: Org | null;
  onOpenOrgSheet: () => void;
  title: string;
  /** Right-hand control on the title row (the handoff's "New" button). */
  action?: ReactNode;
  /** Filter-chip row. Scrolls horizontally when it overflows. */
  filters?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-col gap-3.5 px-4 pb-3 pt-2.5">
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

        {/* Phase 3 mounts the search button here. */}
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
