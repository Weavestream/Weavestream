'use client';

import { Icon } from '../ui';
import { useChatPanel } from './chat-panel-provider';

/**
 * Geometry presets shared with `SidebarToolbar` so the chat toggle
 * blends visually with the rest of the icon strip in either container.
 */
const VARIANT_DIMS = {
  // Material's glyph includes more internal view-box padding than the
  // adjacent 16×16 stroke icons, so it needs a larger nominal size to
  // occupy the same visual area without changing the button geometry.
  sidebar: { box: 26, glyph: 18, radius: 5 },
  topbar: { box: 30, glyph: 23, radius: 6 },
} as const;

/**
 * Ask button rendered alongside the rest of the shell toolbar.
 * Toggles the chat panel open/closed. The `variant` prop selects
 * sidebar (compact) or topbar (slightly larger / thicker) geometry.
 *
 * The open state deliberately departs from the neutral
 * `ToolbarIconButton` active treatment (`data-active='true'`) and
 * takes the accent tint instead (`data-active='accent'`, painted in
 * globals.css). This button is the panel's *only* close control, so
 * "the panel is open, click here to close it" has to read at a
 * glance; a one-notch background shift next to an already-muted
 * glyph does not.
 */
export function ChatPanelToggle({
  variant = 'sidebar',
}: {
  variant?: 'sidebar' | 'topbar';
}) {
  const { state, toggle } = useChatPanel();
  const active = state.isOpen;
  const dims = VARIANT_DIMS[variant];
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={active ? 'Close Ask anything' : 'Ask anything'}
      title={active ? 'Close Ask anything' : 'Ask anything'}
      onClick={toggle}
      className="sidebar-toolbar-icon"
      data-active={active ? 'accent' : undefined}
      style={{
        width: dims.box,
        height: dims.box,
        border: 'none',
        display: 'grid',
        placeItems: 'center',
        borderRadius: dims.radius,
        position: 'relative',
        cursor: 'pointer',
      }}
    >
      <Icon.askAnything size={dims.glyph} />
    </button>
  );
}
