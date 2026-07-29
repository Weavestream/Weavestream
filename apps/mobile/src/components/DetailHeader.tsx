import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { useBackLabel, useBackOr, useWillPop } from '../lib/use-back';

/**
 * The back row for pushed screens (1c: chevron + parent label), with a
 * right-hand slot for the screen's actions. Owns the top safe-area
 * inset, like ScreenHeader does for tab roots.
 *
 * Back prefers real history so the previous screen's filter/search
 * state survives. When there is NO in-app history to pop (a cold deep
 * link), the chevron goes to the launcher and says "Home" (Phase 5b):
 * the deep link's record may belong to any org, so the org-free home is
 * the only fallback that cannot land the technician in a wrong-org
 * list. `backTo`/`backSearch` remain the structural target for the
 * popping case's label semantics only.
 *
 * `backLabel` is the STRUCTURAL parent's name ("Passwords"). When the
 * pushing screen stamped a different origin (a search result stamps
 * "Search"), `useBackLabel` shows that instead — but only when the
 * chevron will genuinely pop back there, so the label never lies.
 */
export function DetailHeader({
  backLabel,
  backTo,
  backSearch,
  actions,
}: {
  backLabel: string;
  /** Structural destination when history pops (label semantics). */
  backTo: string;
  /** Search params for the structural path — e.g. the list's filters. */
  backSearch?: Record<string, unknown>;
  actions?: ReactNode;
}) {
  const willPop = useWillPop();
  const onBack = useBackOr(
    willPop ? backTo : '/app',
    willPop ? backSearch : undefined,
  );
  const stampedLabel = useBackLabel(backLabel);
  const label = willPop ? stampedLabel : 'Home';

  return (
    // Shared column pattern — see ScreenHeader / tokens.css.
    <header className="mx-auto flex w-full max-w-page shrink-0 items-center justify-between gap-2 px-3 pb-1 pt-edge-t">
      <button
        type="button"
        onClick={onBack}
        className={
          'flex h-tap min-w-0 items-center gap-0.5 rounded-btn py-1 pl-1 pr-3 ' +
          'text-body font-medium text-text-2 active:bg-panel-2'
        }
      >
        <Icon name="chevron_left" size={24} className="text-muted" />
        <span className="truncate">{label}</span>
      </button>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
