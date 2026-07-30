import type { ReactNode } from 'react';

/**
 * Chrome for the full-viewport form screens (create/edit password).
 *
 * These are ordinary ROUTED PAGES, not overlays: the Shell hides the
 * tab bar for their paths (`hideTabBarFor`), so nothing focusable sits
 * behind them — no dialog semantics, focus trap, or scroll lock
 * needed, and hardware back keeps working untouched. Because the tab
 * bar is gone, this chrome owns BOTH safe-area edges.
 */
export function FormScreenChrome({
  title,
  onCancel,
  saveLabel = 'Save',
  saveDisabled,
  onSave,
  submitFor,
  children,
}: {
  title: string;
  onCancel: () => void;
  saveLabel?: string;
  /** Required whenever `onSave` or `submitFor` is provided; ignored otherwise. */
  saveDisabled?: boolean;
  /**
   * Omit for chrome-only screens with no save action (the asset layout
   * chooser) — an invisible placeholder keeps the title centered. Also omit
   * when using `submitFor`, which submits natively instead.
   */
  onSave?: () => void;
  /**
   * `id` of a `<form>` in `children` that this Save should submit natively.
   *
   * Makes Save the form's **default button**, which is the only way to get
   * Enter/Go from the keyboard: per the HTML implicit-submission algorithm a
   * form with more than one field that blocks implicit submission (any text
   * or password input) and *no* submit button silently does nothing on
   * Enter. A `type="button"` calling `requestSubmit()` looks equivalent and
   * is not — it fixes the click and leaves the keyboard dead.
   *
   * `disabled` then also gates the keyboard, since the algorithm skips a
   * disabled default button. Use this instead of `onSave` when the screen's
   * fields are a real form; the form's own `onSubmit` carries the logic.
   */
  submitFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-bg">
      {/* Shared column pattern — see ScreenHeader / tokens.css. */}
      <header className="mx-auto flex w-full max-w-page shrink-0 items-center justify-between gap-2 px-2 pb-2 pt-edge-t">
        <button
          type="button"
          onClick={onCancel}
          className="h-tap shrink-0 rounded-btn px-3 text-body font-medium text-muted active:bg-panel-2"
        >
          Cancel
        </button>
        <h1 className="min-w-0 truncate text-[17px] font-semibold text-text">
          {title}
        </h1>
        {onSave || submitFor ? (
          <button
            // `form` associates it across the DOM, so the button can live up
            // here in the header and still be the form's default button.
            type={submitFor ? 'submit' : 'button'}
            form={submitFor}
            onClick={onSave}
            disabled={saveDisabled}
            className={
              'h-tap shrink-0 rounded-btn px-3 text-body font-semibold ' +
              (saveDisabled ? 'text-dim' : 'text-accent-text active:bg-panel-2')
            }
          >
            {saveLabel}
          </button>
        ) : (
          <span
            aria-hidden
            className="invisible h-tap shrink-0 px-3 text-body font-semibold"
          >
            {saveLabel}
          </span>
        )}
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col gap-4 overflow-y-auto px-4 pb-edge-b pt-1">
        {children}
      </main>
    </div>
  );
}
