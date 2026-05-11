'use client';

import { Icon } from '../ui';
import { useChatPanel } from './chat-panel-provider';

/**
 * Sparkle button in the sidebar bottom toolbar. Toggles the chat panel
 * open/closed. Lights up when the panel is open (matches the
 * `ToolbarIconButton` active treatment in sidebar-toolbar.tsx).
 */
export function ChatPanelToggle() {
  const { state, toggle } = useChatPanel();
  const active = state.isOpen;
  const ChatIcon = active ? Icon.chatFilled : Icon.chat;
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label="AI chat"
      title="AI chat"
      onClick={toggle}
      className="sidebar-toolbar-icon"
      style={{
        width: 26,
        height: 26,
        border: 'none',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 5,
        color: active ? 'var(--text)' : 'var(--muted)',
        background: 'transparent',
        position: 'relative',
        cursor: 'pointer',
      }}
    >
      <ChatIcon size={14} stroke={1.5} />
    </button>
  );
}
