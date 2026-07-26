import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Toasts, for transient feedback on a *write* — "copied", "couldn't
 * save". A read that failed gets an `ErrorBanner` instead, so the
 * failure stays on screen next to the thing that didn't load.
 *
 * Two deliberate differences from desktop's version:
 *
 *  - **Bottom-anchored above the tab bar**, not bottom-right, and
 *    safe-area aware. A toast under the home indicator is unreadable.
 *  - **`aria-live`** on the container. Desktop's toasts are silent to a
 *    screen reader; that is a gap, not a convention to inherit.
 */

type Tone = 'default' | 'ok' | 'danger';
interface Toast {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<{
  push: (message: string, tone?: Tone) => void;
} | null>(null);

/** Tint layered over an opaque base — see the note at the render site. */
const TONE_BACKGROUND: Record<Tone, string> = {
  default: 'var(--surface)',
  ok: 'linear-gradient(var(--ok-soft), var(--ok-soft)), var(--surface)',
  danger:
    'linear-gradient(var(--danger-soft), var(--danger-soft)), var(--surface)',
};

const VISIBLE_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Monotonic counter rather than `crypto.randomUUID()`: the app is
  // routinely served over plain HTTP to LAN devices in development,
  // where secure-context crypto is undefined (CLAUDE.md).
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const push = useCallback((message: string, tone: Tone = 'default') => {
    const id = ++nextId.current;
    setToasts((t) => [...t, { id, message, tone }]);
    const timer = setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
      timers.current.delete(id);
    }, VISIBLE_MS);
    timers.current.set(id, timer);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        // `polite`, not `assertive`: a copy confirmation must not
        // interrupt whatever the user is reading.
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-toast flex flex-col items-center gap-2 px-4 pb-[calc(var(--pad-edge-b)+72px)]"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              'pointer-events-auto w-full max-w-md rounded-card border border-line ' +
              'px-4 py-3 text-body text-text shadow-seg'
            }
            // Opaque, tinted. The `-soft` tokens are 12%-alpha TINTS
            // meant to layer on an opaque surface — used alone as a
            // floating toast's background, the list bleeds through and
            // the message is hard to read. Compositing the tint over
            // `--surface` keeps the tone without the transparency.
            // (Desktop's toasts are flat `--panel`; the tone tint is
            // mobile's own addition.)
            style={{ background: TONE_BACKGROUND[t.tone] }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
