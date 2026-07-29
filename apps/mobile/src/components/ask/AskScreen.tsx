import { useEffect, useId, useRef } from 'react';
import { Icon } from '../Icon';
import { useOrgScope } from '../../lib/org-scope';
import { useAsk } from './AskProvider';
import { Composer } from './Composer';
import { Transcript } from './Transcript';

/**
 * Ask anything — a FULL-SCREEN takeover per the mockups (own header,
 * close button, no tab bar behind it), not a bottom sheet. Presented
 * via `?sheet=ask` so back closes it; the transcript lives in
 * AskProvider above this component and survives close/reopen.
 *
 * Dialog semantics reimplemented minimally from Sheet.tsx (focus to
 * close on open, per-Tab trap, Escape closes, focus return, body
 * scroll lock) — the sheet's grabber/drag chrome doesn't apply here.
 */
export function AskScreen({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return <AskScreenBody onClose={onClose} />;
}

function AskScreenBody({ onClose }: { onClose: () => void }) {
  const { state, newChat } = useAsk();
  const { currentOrg } = useOrgScope();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // The close button, NEVER the composer — the no-autofocus rule.
    closeRef.current?.focus();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Re-queried per Tab (Sheet.tsx precedent) — the transcript grows.
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), ' +
          'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    const returnFocus = returnFocusRef;
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      returnFocus.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-sheet flex flex-col bg-bg"
    >
      <header className="mx-auto flex w-full max-w-page shrink-0 items-center gap-2.5 px-4 pb-3 pt-edge-t">
        <Icon name="auto_awesome" size={23} className="shrink-0 text-accent" />
        <h1
          id={titleId}
          className="shrink-0 text-[19px] font-semibold tracking-[-0.015em] text-text"
        >
          Ask anything
        </h1>
        {/* Scope is EXPLICIT, never implied (Phase 5b): a global,
            org-free conversation says so rather than omitting the chip. */}
        <span className="min-w-0 truncate rounded-md bg-panel-2 px-2 py-1 text-[12px] font-medium text-muted">
          {currentOrg ? currentOrg.name : 'All organizations'}
        </span>
        <div className="flex-1" />
        {state.messages.length > 0 && (
          <button
            type="button"
            onClick={newChat}
            className="shrink-0 rounded-btn px-2 text-[15px] font-medium text-accent-text active:bg-panel-2"
          >
            New chat
          </button>
        )}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-btn ' +
            'bg-panel-2 text-text-2 active:bg-line'
          }
        >
          <Icon name="close" size={22} />
        </button>
      </header>

      <Transcript state={state} />

      <footer className="mx-auto flex w-full max-w-page shrink-0 flex-col gap-2 px-4 pb-edge-b pt-2">
        {state.sendError && (
          <p role="alert" className="px-1 text-[13px] text-danger">
            {state.sendError}
          </p>
        )}
        <p className="px-1 text-[13px] text-faint">
          Ask anything reads and explains. It can draft an article — never a
          password or asset.
        </p>
        <Composer />
      </footer>
    </div>
  );
}
