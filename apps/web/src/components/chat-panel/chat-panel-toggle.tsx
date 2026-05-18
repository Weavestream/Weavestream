'use client';

import { Icon } from '../ui';
import { useChatPanel } from './chat-panel-provider';

/**
 * Geometry presets shared with `SidebarToolbar` so the chat toggle
 * blends visually with the rest of the icon strip in either container.
 */
const VARIANT_DIMS = {
  sidebar: { box: 26, glyph: 14, stroke: 1.5, radius: 5 },
  topbar: { box: 30, glyph: 18, stroke: 1.75, radius: 6 },
} as const;

/**
 * Sparkle button rendered alongside the rest of the shell toolbar.
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
  const ChatIcon = active ? Icon.chatFilled : Icon.chat;
  const dims = VARIANT_DIMS[variant];
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label="AI chat"
      title="AI chat"
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
      <ChatIcon size={dims.glyph} stroke={dims.stroke} />
    </button>
  );
}
