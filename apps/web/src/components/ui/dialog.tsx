'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 420,
}: {
  open: boolean;
  onClose: () => void;
  // ReactNode so callers can compose inline badges / tags into the
  // dialog title (e.g. the audit drawer).
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
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
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, handleKey]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const overlay: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 60,
    background: 'rgba(0,0,0,0.55)',
    display: 'grid',
    placeItems: 'center',
    padding: 16,
  };
  const panel: CSSProperties = {
    width: '100%',
    maxWidth: width,
    // Cap the panel to the viewport (minus the overlay's 16px padding
    // on each side) and lay out as a column so the body can scroll
    // independently of the sticky header/footer. Without this, dialogs
    // with growing content (e.g. a tags field accumulating chips, a
    // long notes block) push the action buttons below the fold.
    maxHeight: 'calc(100vh - 32px)',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    boxShadow: 'var(--shadow-2)',
    outline: 'none',
    // Neutralise inherited `text-align` from the call site (e.g. a
    // right-aligned table cell or row-actions container) — `text-align`
    // is an inherited property even across fixed-positioned children,
    // so without this the dialog body would render right-aligned when
    // launched from a right-aligned column.
    textAlign: 'start',
  };

  return (
    <div
      style={overlay}
      onMouseDown={(e) => {
        overlayMouseDownRef.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        const startedOnOverlay = overlayMouseDownRef.current;
        overlayMouseDownRef.current = false;
        if (startedOnOverlay && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        style={panel}
      >
        <header
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text)',
              letterSpacing: -0.2,
              flex: 1,
            }}
          >
            {title}
          </h2>
        </header>
        {/* `minHeight: 0` is required for `overflow: auto` to actually
            clip inside a flex column. Without it, the body's default
            `min-height: auto` keeps it sized to content, so long
            dialogs (e.g. the image picker grid) overflow the panel
            instead of scrolling. */}
        <div style={{ padding: 16, overflow: 'auto', flex: 1, minHeight: 0 }}>
          {children}
        </div>
        {footer && (
          <footer
            style={{
              padding: '12px 16px',
              borderTop: '1px solid var(--line)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              flexShrink: 0,
            }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
