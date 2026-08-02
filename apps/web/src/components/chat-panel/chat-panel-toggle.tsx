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
 * Toggles the chat panel open/closed and lights up when the panel is
 * open (matches the `ToolbarIconButton` active treatment in
 * sidebar-toolbar.tsx). The `variant` prop selects sidebar (compact)
 * or topbar (slightly larger / thicker) geometry.
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
      aria-label="Ask anything"
      title="Ask anything"
      onClick={toggle}
      className="sidebar-toolbar-icon"
      style={{
        width: dims.box,
        height: dims.box,
        border: 'none',
        display: 'grid',
        placeItems: 'center',
        borderRadius: dims.radius,
        color: active ? 'var(--text)' : 'var(--muted)',
        background: 'transparent',
        position: 'relative',
        cursor: 'pointer',
      }}
    >
      <Icon.askAnything size={dims.glyph} />
    </button>
  );
}
