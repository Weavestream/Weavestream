import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { useBackOr } from '../lib/use-back';

/**
 * The back row for pushed screens (1c: chevron + parent label), with a
 * right-hand slot for the screen's actions. Owns the top safe-area
 * inset, like ScreenHeader does for tab roots.
 *
 * Back prefers real history so the previous screen's filter/search
 * state survives; a cold deep link with no history entry falls back to
 * a replace-navigation to `backTo`.
 */
export function DetailHeader({
  backLabel,
  backTo,
  backSearch,
  actions,
}: {
  backLabel: string;
  /** Structural destination when history can't be popped (use-back.ts). */
  backTo: string;
  /** Search params for the structural path — e.g. the list's filters. */
  backSearch?: Record<string, unknown>;
  actions?: ReactNode;
}) {
  const onBack = useBackOr(backTo, backSearch);

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
        <span className="truncate">{backLabel}</span>
      </button>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
