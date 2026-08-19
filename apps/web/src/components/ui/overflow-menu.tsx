'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Icon, type IconComponent } from './icon';

/**
 * The "…" overflow menu that closes a page's action cluster.
 *
 * Detail headers used to spend a whole 50px row on four or five
 * equal-weight buttons. The pattern now is one primary control (Edit,
 * Save, Restore) plus this, sitting in the breadcrumb row beside the
 * global cluster — so the header is one row again and the secondary
 * actions are one click away instead of one glance.
 *
 * `attention` puts a tone dot on the trigger. That is the same
 * contract `ShowMore` carries (see `show-more.tsx`): a collapsed
 * control that hides something needing review has to say so, or
 * collapsing buries the anomaly. The article header uses it for a
 * draft in progress, which was previously a warn `Tag` in the row.
 *
 * Positioning copies `ScopePill`'s recents popover rather than using
 * `position: absolute`: the breadcrumb row scrolls horizontally, and
 * an absolutely positioned child of it would be clipped.
 */
export function OverflowMenu({
  label = 'More actions',
  attention,
  children,
}: {
  /** Accessible name + tooltip for the trigger. */
  label?: string;
  /** Tone dot on the trigger when the menu hides something to review. */
  attention?: 'warn' | 'danger';
  /**
   * Render prop so a row can close the menu after acting. Rows that
   * open a dialog or panel must close it — leaving both open stacks a
   * popover under a modal.
   */
  children: (close: () => void) => ReactNode;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

  const close = useCallback(() => setOpen(false), []);

  /**
   * Close and hand focus back to the trigger. Used for dismissal —
   * Escape, or tabbing out — where the keyboard user is still where
   * they started and must not be dumped at the top of the document.
   *
   * Deliberately NOT what the render prop's `close` does: a row that
   * opens a dialog or a sheet has its own focus target, and stealing
   * focus back to the trigger first would fight that panel's autofocus.
   */
  const closeAndRestore = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  /**
   * Roving focus across the rows. `role="menu"` promises arrow-key
   * navigation, so either this exists or the role is wrong; the rows
   * carry `tabIndex={-1}` and are moved through programmatically, which
   * is the standard menu pattern.
   */
  const focusItem = useCallback((index: number) => {
    const items = popoverRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    );
    if (!items || items.length === 0) return;
    const wrapped = (index + items.length) % items.length;
    items[wrapped]?.focus();
  }, []);

  const moveFocus = useCallback(
    (delta: number) => {
      const items = popoverRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      );
      if (!items || items.length === 0) return;
      const current = Array.from(items).indexOf(
        document.activeElement as HTMLElement,
      );
      focusItem(current === -1 ? 0 : current + delta);
    },
    [focusItem],
  );

  // Opening a menu puts you *in* it. Without this the first arrow press
  // does nothing, because focus never left the trigger.
  useEffect(() => {
    if (open) focusItem(0);
  }, [open, focusItem]);

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 6;
    const viewportPad = 12;
    const width = Math.min(236, window.innerWidth - viewportPad * 2);
    // Right-aligned with the trigger, clamped into the viewport. The
    // trigger sits at the right edge of the row, so a left-aligned
    // popover would hang off the window on every page.
    const left = Math.max(
      viewportPad,
      Math.min(rect.right - width, window.innerWidth - width - viewportPad),
    );
    setPosition({ left, top: rect.bottom + gap, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Listens on the document rather than the popover so Escape works
      // even when focus has wandered (a click on the popover's padding
      // leaves `document.body` focused).
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeAndRestore();
      }
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, updatePosition, closeAndRestore]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => {
          updatePosition();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          // Down-arrow opens into the first row, matching every other
          // menu button a keyboard user has met.
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            updatePosition();
            setOpen(true);
          }
        }}
        style={{
          position: 'relative',
          width: 30,
          height: 30,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 5,
          border: '1px solid var(--line-2)',
          background: open ? 'var(--panel-2)' : 'transparent',
          color: 'var(--text-2)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <Icon.dots size={13} />
        {attention && (
          <span
            role="img"
            aria-label="needs attention"
            style={{
              position: 'absolute',
              top: -1,
              right: -1,
              width: 7,
              height: 7,
              borderRadius: '50%',
              background:
                attention === 'danger' ? 'var(--danger)' : 'var(--warn)',
              // Rings the dot in the page background so it reads as a
              // badge rather than a smudge on the button's border.
              boxShadow: '0 0 0 2px var(--bg)',
            }}
          />
        )}
      </button>
      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              moveFocus(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              moveFocus(-1);
            } else if (e.key === 'Home') {
              e.preventDefault();
              focusItem(0);
            } else if (e.key === 'End') {
              e.preventDefault();
              focusItem(-1);
            } else if (e.key === 'Tab') {
              // Tab dismisses a menu. Focus goes back to the trigger
              // first so the browser's own Tab handling then continues
              // from there, not from the top of the document.
              closeAndRestore();
            }
          }}
          style={{
            position: 'fixed',
            left: position?.left ?? 12,
            top: position?.top ?? 50,
            width: position?.width ?? 236,
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: 'min(70vh, 460px)',
            overflow: 'auto',
            zIndex: 70,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-2)',
            padding: 6,
          }}
        >
          {children(close)}
        </div>
      )}
    </>
  );
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  width: '100%',
  padding: '6px 8px',
  borderRadius: 5,
  fontSize: 12.5,
  fontWeight: 500,
  textAlign: 'left',
  textDecoration: 'none',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

/**
 * One row. Renders a `Link` when `href` is set and a `button`
 * otherwise, so keyboard and middle-click behave the way the action
 * actually is — navigation vs. mutation.
 */
export function MenuItem({
  icon,
  glyph,
  children,
  href,
  onClick,
  tone,
  trailing,
  disabled,
}: {
  /** Icon from the shared set. Ignored when `glyph` is given. */
  icon?: IconComponent;
  /** Escape hatch for a stateful glyph (the star's filled variant). */
  glyph?: ReactNode;
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  tone?: 'danger';
  /** Right-aligned decoration — a tag, a count. */
  trailing?: ReactNode;
  disabled?: boolean;
}) {
  const IconCmp = icon;
  const color = tone === 'danger' ? 'var(--danger)' : 'var(--text)';
  const body = (
    <>
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          display: 'grid',
          placeItems: 'center',
          color: tone === 'danger' ? 'var(--danger)' : 'var(--dim)',
          flexShrink: 0,
        }}
      >
        {glyph ?? (IconCmp ? <IconCmp size={14} /> : null)}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </span>
      {trailing}
    </>
  );
  const style: CSSProperties = {
    ...rowStyle,
    color,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
  if (href && !disabled) {
    return (
      <Link
        href={href}
        role="menuitem"
        tabIndex={-1}
        prefetch={false}
        onClick={onClick}
        className="sidebar-switcher-entry"
        style={style}
      >
        {body}
      </Link>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      className="sidebar-switcher-entry"
      style={style}
    >
      {body}
    </button>
  );
}

/** Separates the destructive tail of a menu from the rest. */
export function MenuDivider() {
  return (
    <div
      aria-hidden
      style={{ height: 1, background: 'var(--line)', margin: '6px 2px' }}
    />
  );
}
