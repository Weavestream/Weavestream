'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';

export type SheetSide = 'left' | 'right' | 'bottom';

/**
 * Lightweight edge-anchored sheet used for the mobile sidebar drawer,
 * the article "Linked items" panel, and any other bottom/side drawer
 * surface we need. Intentionally minimal (no Radix) because the rest
 * of the app uses vanilla JSX + inline styles and pulling in Radix
 * here would force a much larger refactor.
 *
 * Behaviour:
 *   - Clicking the backdrop calls `onClose`.
 *   - Escape closes.
 *   - Tab focus is not trapped — callers are expected to keep the
 *     interactive surface short (nav list, linked items, filters).
 *     We do set `aria-modal` + `role="dialog"` so screen readers treat
 *     the sheet as a modal region.
 *   - `side` drives the slide animation origin and the default size
 *     (left/right are 88% wide capped at 320, bottom is 85dvh tall).
 */
export function Sheet({
  open,
  onClose,
  side = 'left',
  children,
  width,
  height,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  side?: SheetSide;
  children: ReactNode;
  /** Override for left/right sheets. Numbers become px. */
  width?: number | string;
  /** Override for bottom sheets. Numbers become px. */
  height?: number | string;
  ariaLabel?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayMouseDownRef = useRef(false);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKey);
    // Preserve scroll position while the sheet is open; `overflow:
    // hidden` on the body is enough for mobile Safari.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prev;
    };
  }, [open, handleKey]);

  if (!open) return null;

  const overlay: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 80,
    background: 'rgba(0, 0, 0, 0.55)',
    display: 'flex',
    alignItems: side === 'bottom' ? 'flex-end' : 'stretch',
    justifyContent:
      side === 'left' ? 'flex-start' : side === 'right' ? 'flex-end' : 'stretch',
  };

  const panel: CSSProperties = {
    background: 'var(--panel)',
    borderColor: 'var(--line)',
    borderStyle: 'solid',
    boxShadow: 'var(--shadow-2)',
    display: 'flex',
    flexDirection: 'column',
    outline: 'none',
    maxWidth: '100%',
    maxHeight: '100%',
    overflow: 'hidden',
  };

  if (side === 'left') {
    panel.width = width ?? 'min(88vw, 320px)';
    panel.height = '100%';
    panel.borderWidth = '0 1px 0 0';
  } else if (side === 'right') {
    panel.width = width ?? 'min(88vw, 360px)';
    panel.height = '100%';
    panel.borderWidth = '0 0 0 1px';
  } else {
    panel.width = '100%';
    panel.height = height ?? 'min(85dvh, 640px)';
    panel.borderWidth = '1px 0 0';
    panel.borderTopLeftRadius = 12;
    panel.borderTopRightRadius = 12;
  }

  return (
    <div
      style={overlay}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onMouseDown={(e) => {
        overlayMouseDownRef.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        const startedOnOverlay = overlayMouseDownRef.current;
        overlayMouseDownRef.current = false;
        if (startedOnOverlay && e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} style={panel} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
