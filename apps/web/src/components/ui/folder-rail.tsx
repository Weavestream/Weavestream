'use client';

import type { ReactNode } from 'react';
import { Icon } from './icon';

/**
 * The folder-rail vocabulary, shared by every browser that puts a tree
 * beside a list (passwords, articles).
 *
 * Only the row shapes live here, not the tree walk: the browsers carry
 * different folder models — a flat `parentId` list on one side, a
 * server-nested tree on the other — and flattening both into one generic
 * component would cost more than it saves. What has to agree is what a
 * row looks like and how it behaves, which is exactly this file.
 *
 * Two rules the rows encode, learned the hard way:
 *
 *   1. Rows are containers, never `role="button"`. A button must not
 *      contain focusable descendants, and a parent key handler around
 *      nested controls swallows their Enter/Space — the disclosure and
 *      edit controls stop working from the keyboard while still looking
 *      fine with a mouse.
 *   2. Inactive rows leave `background` off the inline style so the
 *      stylesheet's `:hover` can win. An inline `transparent` outranks
 *      it and the rail goes dead under the pointer.
 */

/**
 * Rail width, shared so the two browsers cannot drift apart. Wide enough
 * that a nested folder name still has room after the guide indent, which
 * 220 did not quite give it.
 */
export const RAIL_WIDTH = 240;

/** Hairline between the rail's groups. */
export function RailDivider() {
  return (
    <div
      aria-hidden
      style={{ height: 1, background: 'var(--line)', margin: '8px 2px' }}
    />
  );
}

/**
 * Group heading. Deliberately the same mono uppercase scale the panel
 * headers and table column headers already use — before this the rails
 * each had a scale of their own.
 */
export function RailSection({
  label,
  action,
}: {
  label: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        height: 22,
        padding: '0 8px',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        color: 'var(--dim)',
      }}
    >
      <span>{label}</span>
      {action}
    </div>
  );
}

/**
 * One folder, or one of the synthetic views above them ("All",
 * "Unfiled"). Selection is neutral — a `--panel-2` pill — because the
 * accent is spent on actions, not on where you happen to be standing.
 */
export function RailRow({
  active,
  onClick,
  icon,
  label,
  count,
  showCount,
  disclosure,
  action,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count: number;
  /**
   * The account's "Show item counts in the sidebar" preference. Off by
   * default: the tree is a place, and the list one click away is the
   * truth — which also spares an own-versus-subtree answer to get wrong.
   */
  showCount: boolean;
  /**
   * The expand/collapse control, in its own gutter ahead of the icon.
   * Its own hit target, so opening a parent to look inside no longer
   * forces a selection.
   */
  disclosure?: ReactNode;
  /**
   * Row-level control, between the label and the count. Inside the count
   * on purpose: the count is a stable right edge, and a control that
   * came and went outside it would shift the number.
   */
  action?: ReactNode;
}) {
  return (
    <div
      className="rail-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 28,
        padding: '0 8px',
        background: active ? 'var(--panel-2)' : undefined,
        color: active ? 'var(--text)' : 'var(--text-2)',
        fontWeight: active ? 600 : 400,
        fontSize: 13,
        textAlign: 'left',
      }}
    >
      <span
        style={{
          width: 14,
          height: 18,
          display: 'inline-grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        {disclosure}
      </span>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: '100%',
          font: 'inherit',
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 12,
            height: 12,
            display: 'inline-grid',
            placeItems: 'center',
            flexShrink: 0,
            color: active ? 'var(--text-2)' : 'var(--dim)',
          }}
        >
          {icon}
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
          {label}
        </span>
      </button>
      {action}
      {showCount && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            fontWeight: 400,
            color: active ? 'var(--text-2)' : 'var(--muted)',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

/**
 * Disclosure chevron for a row with children. Exported so both rails
 * render the same control rather than each drawing its own.
 */
export function RailDisclosure({
  open,
  label,
  onToggle,
}: {
  open: boolean;
  /** Folder name, for the accessible label. */
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={open ? 'Collapse' : 'Expand'}
      aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
      aria-expanded={open}
      className="rail-disclosure"
      style={{
        width: 14,
        height: 18,
        display: 'inline-grid',
        placeItems: 'center',
        borderRadius: 3,
        color: 'var(--dim)',
      }}
    >
      <Icon.chevronD
        size={10}
        style={{
          transform: open ? 'none' : 'rotate(-90deg)',
          transition: 'transform 120ms ease',
        }}
      />
    </button>
  );
}

/**
 * Edit control for the selected folder. Rendered on the row rather than
 * in the toolbar: a control the width of the table away from the thing
 * it acts on reads as ambiguous, whatever its label says.
 */
export function RailEditButton({
  label,
  onClick,
}: {
  /** Folder name, for the tooltip and accessible label. */
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Edit "${label}"`}
      aria-label={`Edit folder ${label}`}
      className="rail-disclosure"
      style={{
        width: 18,
        height: 18,
        display: 'inline-grid',
        placeItems: 'center',
        borderRadius: 3,
        color: 'var(--muted)',
        flexShrink: 0,
      }}
    >
      <Icon.edit size={11} />
    </button>
  );
}

/**
 * A tag in the rail. Folders are a place and pick one at a time; tags
 * narrow what is in that place and stack, so they read as ticks rather
 * than as a second selection.
 */
export function RailTagRow({
  name,
  count,
  showCount,
  checked,
  onToggle,
}: {
  name: string;
  count: number;
  showCount: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      className="rail-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 28,
        padding: '0 8px',
        background: checked ? 'var(--panel-2)' : undefined,
        color: checked ? 'var(--text)' : 'var(--text-2)',
        fontWeight: checked ? 600 : 400,
        cursor: 'pointer',
        fontSize: 13,
        textAlign: 'left',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 12,
          height: 12,
          display: 'inline-grid',
          placeItems: 'center',
          flexShrink: 0,
          border: `1px solid ${checked ? 'var(--line-3)' : 'var(--line-2)'}`,
          borderRadius: 3,
          background: checked ? 'var(--text-2)' : 'var(--panel-2)',
          color: checked ? 'var(--panel)' : 'transparent',
        }}
      >
        <Icon.check size={8} />
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
        {name}
      </span>
      {showCount && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            fontWeight: 400,
            color: count === 0 ? 'var(--faint)' : 'var(--muted)',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}
