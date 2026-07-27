import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';

/**
 * Bottom sheet.
 *
 * Hand-rolled, no library — matching how the rest of the codebase does
 * overlays, but not inheriting desktop `ui/sheet.tsx`'s gaps, which are
 * documented there as deliberate omissions for short surfaces. The org
 * sheet is a filter field over 200+ rows, so it needs all of them:
 *
 *  - focus moves in on open, is trapped while open, and **returns to the
 *    trigger** on close
 *  - `role="dialog"` + `aria-modal` + `aria-labelledby` on the title
 *  - Escape closes; body scroll is locked and restored
 *  - drag-to-dismiss, but **only from the grabber/header strip**, so the
 *    gesture never fights the content list's own scroll
 *  - `env(safe-area-inset-bottom)` padding
 *  - motion skipped under `prefers-reduced-motion` (globals.css)
 *
 * The one desktop technique worth stealing verbatim is the scrim
 * pointerdown/pointerup pairing: a press that *starts* inside the panel
 * and *ends* on the scrim must not dismiss.
 */

/** Drag distance past which release dismisses rather than snapping back. */
const DISMISS_THRESHOLD_PX = 90;

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  initialFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Focused on open. Defaults to the close button. NEVER point this at
   * a text input or textarea: on phones, focusing one raises the
   * on-screen keyboard over the sheet the moment it opens (the org
   * sheet's filter did exactly this). Auto-selecting fields is banned
   * in sheets and overlays — the user came to read or tap what the
   * keyboard would bury. The one sanctioned exception is the dedicated
   * search screen (SearchScreen), where tapping the header's search
   * icon IS the intent to type and there is no content underneath yet.
   */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrimPressedRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [dragY, setDragY] = useState(0);
  const dragStartRef = useRef<number | null>(null);
  const dragYRef = useRef(0);

  // Remember what to hand focus back to *before* the sheet takes it.
  useEffect(() => {
    if (open) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    (initialFocusRef?.current ?? closeRef.current)?.focus();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      // Focus trap. Querying on each Tab rather than caching: the org
      // sheet's row list grows as pages load, so a snapshot taken on
      // open would go stale.
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
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, initialFocusRef]);

  // Restore focus on close. Separate effect so it fires on the
  // transition to closed rather than on unmount only — the sheet stays
  // mounted across a `?sheet=` search-param change.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) returnFocusRef.current?.focus();
    wasOpen.current = open;
    if (!open) {
      dragYRef.current = 0;
      setDragY(0);
    }
  }, [open]);

  const onGrabberDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    // Never capture a press that landed on a control.
    //
    // The close button lives inside this drag strip, and pointer capture
    // retargets every subsequent pointer event — *including the derived
    // click* — to the capturing element. Capturing here unconditionally
    // therefore swallowed the button's own click and the sheet became
    // impossible to close with it, while Escape and the scrim still worked.
    if ((e.target as HTMLElement).closest('button, a, input')) return;

    dragStartRef.current = e.clientY;
    // Guarded: jsdom has no pointer capture, and a test that presses the
    // header should exercise the drag logic rather than throw.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);

  const onGrabberMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (dragStartRef.current === null) return;
    // Downward only — dragging up must not stretch the sheet.
    const travelled = Math.max(0, e.clientY - dragStartRef.current);
    // Mirrored into a ref so release can read the distance without going
    // through state. Deciding to dismiss inside a `setDragY` updater would
    // put a side effect in a function React is free to call twice — and
    // `main.tsx` mounts under StrictMode, which does exactly that.
    dragYRef.current = travelled;
    setDragY(travelled);
  }, []);

  const onGrabberUp = useCallback(() => {
    if (dragStartRef.current === null) return;
    dragStartRef.current = null;
    const travelled = dragYRef.current;
    dragYRef.current = 0;
    setDragY(0);
    if (travelled > DISMISS_THRESHOLD_PX) onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div
      className="ws-scrim-enter fixed inset-0 z-sheet flex flex-col justify-end"
      // The scrim itself, at the handoff's ~35% over ink. `dvh` so it
      // covers the *visible* viewport on iOS rather than extending
      // behind the browser chrome.
      style={{ background: 'rgb(23 24 26 / 0.35)', height: '100dvh' }}
      onPointerDown={(e) => {
        scrimPressedRef.current = e.target === e.currentTarget;
      }}
      onPointerUp={(e) => {
        const startedOnScrim = scrimPressedRef.current;
        scrimPressedRef.current = false;
        if (startedOnScrim && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={
          'ws-sheet-enter flex max-h-[86dvh] min-h-0 flex-col ' +
          'rounded-t-sheet bg-bg pb-edge-b'
        }
        style={
          dragY > 0
            ? { transform: `translateY(${dragY}px)`, animation: 'none' }
            : undefined
        }
      >
        {/* Grabber + title form the drag handle. Everything below scrolls
            and is untouched by the gesture. */}
        <div
          className="shrink-0 touch-none px-4.5 pt-3"
          onPointerDown={onGrabberDown}
          onPointerMove={onGrabberMove}
          onPointerUp={onGrabberUp}
          onPointerCancel={onGrabberUp}
        >
          <div className="flex justify-center">
            <div className="h-1 w-10 rounded-full bg-line-3" />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <h2
              id={titleId}
              className="text-sheet-title font-semibold text-text"
            >
              {title}
            </h2>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label={`Close ${title}`}
              className="flex h-10 w-10 items-center justify-center rounded-btn bg-panel-2 text-text-2 active:bg-line"
            >
              <Icon name="close" size={22} />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4.5 pb-4 pt-4">
          {children}
        </div>

        {footer && <div className="shrink-0 px-4.5 pb-2">{footer}</div>}
      </div>
    </div>
  );
}
