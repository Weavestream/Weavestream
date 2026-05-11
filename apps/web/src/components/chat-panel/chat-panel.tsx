'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { Icon } from '../ui';
import {
  useChatPanel,
  type ChatMessage,
  type ChatTab,
} from './chat-panel-provider';
import { ResizeHandle } from './resize-handle';

const MINIMIZED_WIDTH = 40;

export function ChatPanel() {
  const { state } = useChatPanel();
  if (!state.isOpen) return null;
  return state.isMinimized ? <MinimizedPanel /> : <FullPanel />;
}

function FullPanel() {
  const { state, activeTab } = useChatPanel();

  const wrap: CSSProperties = {
    position: 'relative',
    flex: `0 0 ${state.width}px`,
    width: state.width,
    minWidth: state.width,
    height: '100vh',
    background: 'var(--panel)',
    borderLeft: '1px solid var(--line)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  return (
    <aside aria-label="AI chat" style={wrap} className="hide-on-mobile">
      <ResizeHandle />
      <TabStrip />
      {activeTab ? <ChatArea tab={activeTab} /> : <EmptyState />}
    </aside>
  );
}

function MinimizedPanel() {
  const { addFreeformTab, toggleMinimized } = useChatPanel();
  const wrap: CSSProperties = {
    flex: `0 0 ${MINIMIZED_WIDTH}px`,
    width: MINIMIZED_WIDTH,
    height: '100vh',
    background: 'var(--panel)',
    borderLeft: '1px solid var(--line)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '8px 0',
    gap: 4,
  };
  return (
    <aside aria-label="AI chat (minimized)" style={wrap} className="hide-on-mobile">
      <IconButton
        icon="panelRight"
        label="Expand chat panel"
        onClick={toggleMinimized}
      />
      <div style={{ height: 4 }} />
      <IconButton
        icon="plus"
        label="New chat"
        onClick={addFreeformTab}
      />
      <IconButton
        icon="clock"
        label="Chat history"
        onClick={() => {
          /* placeholder — history not implemented */
        }}
      />
    </aside>
  );
}

function TabStrip() {
  const {
    state,
    addFreeformTab,
    toggleMinimized,
    setActiveTab,
    closeTab,
  } = useChatPanel();

  const stripStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'stretch',
    height: 36,
    background: 'var(--panel-2)',
    borderBottom: '1px solid var(--line)',
    flexShrink: 0,
  };

  return (
    <div role="tablist" aria-label="Chat tabs" style={stripStyle}>
      <div
        className="scroll"
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'stretch',
          overflowX: 'auto',
          overflowY: 'hidden',
        }}
      >
        {state.tabs.map((t) => (
          <TabButton
            key={t.id}
            tab={t}
            active={t.id === state.activeTabId}
            onSelect={() => setActiveTab(t.id)}
            onClose={() => closeTab(t.id)}
          />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '0 4px',
          borderLeft: '1px solid var(--line)',
          flexShrink: 0,
        }}
      >
        <IconButton icon="plus" label="New chat" onClick={addFreeformTab} />
        <IconButton
          icon="clock"
          label="Chat history"
          onClick={() => {
            /* placeholder */
          }}
        />
        <IconButton
          icon="panelRight"
          label="Minimize chat panel"
          onClick={toggleMinimized}
        />
      </div>
    </div>
  );
}

function TabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: ChatTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const IconCmp = tab.icon === 'doc' ? Icon.doc : Icon.chat;
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 8px 0 10px',
    height: '100%',
    minWidth: 90,
    maxWidth: 180,
    border: 'none',
    borderRight: '1px solid var(--line)',
    background: active ? 'var(--panel)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--muted)',
    cursor: 'pointer',
    fontSize: 12,
    boxShadow: active ? 'inset 0 2px 0 var(--accent)' : 'none',
    flexShrink: 0,
  };
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={style}
    >
      <IconCmp size={12} style={{ color: 'var(--dim)', flexShrink: 0 }} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={tab.title}
      >
        {tab.title}
      </span>
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        title="Close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          width: 18,
          height: 18,
          display: 'grid',
          placeItems: 'center',
          border: 'none',
          background: 'transparent',
          color: 'var(--dim)',
          borderRadius: 4,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <Icon.x size={10} />
      </button>
    </div>
  );
}

function EmptyState() {
  const { addFreeformTab } = useChatPanel();
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        color: 'var(--muted)',
        textAlign: 'center',
      }}
    >
      <Icon.chat size={28} style={{ color: 'var(--dim)' }} />
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        No conversations open.
        <br />
        Start one to begin chatting.
      </div>
      <button
        type="button"
        onClick={addFreeformTab}
        style={{
          padding: '7px 12px',
          border: '1px solid var(--line)',
          borderRadius: 6,
          background: 'var(--surface)',
          color: 'var(--text)',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        Start a new conversation
      </button>
    </div>
  );
}

function ChatArea({ tab }: { tab: ChatTab }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <MessageList messages={tab.messages} />
      {/* keyed on tab.id so the draft + autosize reset when switching tabs */}
      <Composer key={tab.id} tabId={tab.id} />
    </div>
  );
}

function MessageList({ messages }: { messages: ChatMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);
  return (
    <div
      className="scroll"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '12px 12px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const bubble: CSSProperties = {
    maxWidth: '85%',
    padding: '8px 10px',
    borderRadius: 8,
    fontSize: 13,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    border: '1px solid var(--line)',
    background: isUser
      ? 'color-mix(in oklch, var(--accent) 18%, var(--panel))'
      : 'var(--surface)',
    color: 'var(--text)',
    alignSelf: isUser ? 'flex-end' : 'flex-start',
  };
  return <div style={bubble}>{message.text}</div>;
}

const LINE_HEIGHT = 18;
const COMPOSER_LINES = 4;
const COMPOSER_PADDING_Y = 16; // top + bottom padding inside textarea
const MAX_TEXTAREA_HEIGHT = LINE_HEIGHT * COMPOSER_LINES + COMPOSER_PADDING_Y;
const MIN_TEXTAREA_HEIGHT = LINE_HEIGHT + COMPOSER_PADDING_Y;

function Composer({ tabId }: { tabId: string }) {
  const { appendUserMessage } = useChatPanel();
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.min(MAX_TEXTAREA_HEIGHT, Math.max(MIN_TEXTAREA_HEIGHT, ta.scrollHeight));
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, [value]);

  const canSend = value.trim().length > 0;

  function send() {
    if (!canSend) return;
    appendUserMessage(tabId, value.trim());
    setValue('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      style={{
        borderTop: '1px solid var(--line)',
        padding: 10,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 8,
        background: 'var(--panel)',
        flexShrink: 0,
      }}
    >
      <textarea
        ref={taRef}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Message…"
        style={{
          flex: 1,
          resize: 'none',
          padding: '8px 10px',
          border: '1px solid var(--line)',
          borderRadius: 6,
          background: 'var(--surface)',
          color: 'var(--text)',
          fontSize: 13,
          lineHeight: `${LINE_HEIGHT}px`,
          minHeight: MIN_TEXTAREA_HEIGHT,
          maxHeight: MAX_TEXTAREA_HEIGHT,
          fontFamily: 'inherit',
          outline: 'none',
        }}
      />
      <button
        type="button"
        onClick={send}
        disabled={!canSend}
        aria-label="Send message"
        title="Send"
        style={{
          height: 32,
          width: 32,
          display: 'grid',
          placeItems: 'center',
          border: '1px solid var(--line)',
          borderRadius: 6,
          background: canSend ? 'var(--accent)' : 'var(--surface)',
          color: canSend ? 'var(--accent-ink)' : 'var(--dim)',
          cursor: canSend ? 'pointer' : 'not-allowed',
          flexShrink: 0,
        }}
      >
        <Icon.chevron
          size={14}
          style={{ transform: 'rotate(-90deg)' }}
        />
      </button>
    </div>
  );
}

function IconButton({
  icon,
  label,
  onClick,
  rotate,
}: {
  icon: 'plus' | 'clock' | 'chevron' | 'x' | 'panelRight';
  label: string;
  onClick: () => void;
  rotate?: number;
}) {
  const IconCmp =
    icon === 'plus'
      ? Icon.plus
      : icon === 'clock'
        ? Icon.clock
        : icon === 'x'
          ? Icon.x
          : icon === 'panelRight'
            ? Icon.panelRight
            : Icon.chevron;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="sidebar-toolbar-icon"
      style={{
        width: 26,
        height: 26,
        border: 'none',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 5,
        color: 'var(--muted)',
        background: 'transparent',
        cursor: 'pointer',
      }}
    >
      <IconCmp
        size={14}
        stroke={1.5}
        style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined}
      />
    </button>
  );
}
