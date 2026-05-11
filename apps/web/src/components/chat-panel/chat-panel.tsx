'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../ui';
import {
  useChatPanel,
  type ChatMessage,
  type ChatTab,
} from './chat-panel-provider';
import { ResizeHandle } from './resize-handle';
import { ChatHistoryPopover } from './chat-history-popover';

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
  const historyRef = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
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
        ref={historyRef}
        icon="clock"
        label="Chat history"
        onClick={() => setHistoryOpen((v) => !v)}
      />
      {historyOpen ? (
        <ChatHistoryPopover
          anchorRef={historyRef}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
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
  const historyRef = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

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
          ref={historyRef}
          icon="clock"
          label="Chat history"
          onClick={() => setHistoryOpen((v) => !v)}
        />
        <IconButton
          icon="panelRight"
          label="Minimize chat panel"
          onClick={toggleMinimized}
        />
      </div>
      {historyOpen ? (
        <ChatHistoryPopover
          anchorRef={historyRef}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
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
      {tab.messages.length === 0 ? (
        <ChatWelcome />
      ) : (
        <MessageList messages={tab.messages} />
      )}
      {/* keyed on tab.id so the draft + autosize reset when switching tabs */}
      <Composer
        key={tab.id}
        tabId={tab.id}
        disabled={tab.streamingMessageId !== null}
      />
    </div>
  );
}

function ChatWelcome() {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        color: 'var(--muted)',
        textAlign: 'center',
        gap: 8,
      }}
    >
      <Icon.chat size={28} style={{ color: 'var(--dim)' }} />
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        Ask anything to get started.
      </div>
    </div>
  );
}

function MessageList({ messages }: { messages: ChatMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  // Scroll on length changes (new message) and on the streaming
  // assistant's text growth, so the latest tokens stay in view.
  const tail = messages[messages.length - 1];
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, tail?.text.length]);
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
  const hasError = !!message.error;
  // Many OpenAI-compatible servers (Ollama, llama.cpp, vLLM with some
  // chat templates) emit a leading `\n` or `\n\n` before the real
  // content. `whiteSpace: pre-wrap` faithfully renders that as an
  // empty line at the top of the bubble — visually it looks like the
  // bubble has spurious top padding. Strip leading whitespace at the
  // bubble level so historical and streaming messages look identical.
  const displayText = isUser ? message.text : message.text.replace(/^\s+/, '');
  const isEmptyPending =
    message.pending && displayText.length === 0 && !hasError;
  const bubble: CSSProperties = {
    maxWidth: '85%',
    padding: '8px 10px',
    borderRadius: 8,
    fontSize: 13,
    lineHeight: 1.45,
    // User bubbles render plain text → preserve newlines. Assistant
    // bubbles render Markdown, which provides its own block layout,
    // so pre-wrap there would double-collapse.
    whiteSpace: isUser ? 'pre-wrap' : 'normal',
    wordBreak: 'break-word',
    border: '1px solid var(--line)',
    background: hasError
      ? 'color-mix(in oklch, var(--danger, #c0392b) 12%, var(--panel))'
      : isUser
        ? 'color-mix(in oklch, var(--accent) 18%, var(--panel))'
        : 'var(--surface)',
    color: 'var(--text)',
    alignSelf: isUser ? 'flex-end' : 'flex-start',
  };
  if (isEmptyPending) {
    return (
      <div style={bubble} aria-label="Assistant is typing">
        <TypingDots />
      </div>
    );
  }
  return (
    <div style={bubble} className={isUser ? undefined : 'chat-md'}>
      {isUser ? displayText : <AssistantMarkdown text={displayText} />}
      {message.pending && !hasError ? <Caret /> : null}
      {hasError ? (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: 'var(--danger, #c0392b)',
            fontStyle: 'italic',
          }}
        >
          {message.error}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders assistant Markdown with a chat-tuned typographic scale and
 * tight vertical rhythm. `react-markdown` already sanitises (no raw
 * HTML), so we don't need extra escaping. GFM gives us tables,
 * task-lists, strikethrough, and autolinks.
 *
 * The styles live in a sibling `<style>` block keyed off the
 * `.chat-md` class so they only affect chat bubbles.
 */
function AssistantMarkdown({ text }: { text: string }) {
  return (
    <>
      <style>{CHAT_MD_STYLES}</style>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </>
  );
}

const CHAT_MD_STYLES = `
.chat-md > :first-child { margin-top: 0; }
.chat-md > :last-child { margin-bottom: 0; }
.chat-md p { margin: 0 0 8px; }
.chat-md p:last-child { margin-bottom: 0; }
.chat-md h1, .chat-md h2, .chat-md h3, .chat-md h4 {
  font-weight: 600;
  margin: 12px 0 6px;
  line-height: 1.25;
}
.chat-md h1 { font-size: 16px; }
.chat-md h2 { font-size: 15px; }
.chat-md h3 { font-size: 14px; }
.chat-md h4 { font-size: 13px; }
.chat-md ul, .chat-md ol {
  margin: 4px 0 8px;
  padding-left: 20px;
}
.chat-md li { margin: 2px 0; }
.chat-md li > p { margin: 0; }
.chat-md a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.chat-md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--panel-2);
  border: 1px solid var(--line);
}
.chat-md pre {
  margin: 6px 0;
  padding: 8px 10px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.4;
}
.chat-md pre code {
  background: transparent;
  border: none;
  padding: 0;
  border-radius: 0;
  font-size: 12px;
  white-space: pre;
}
.chat-md blockquote {
  margin: 6px 0;
  padding: 2px 10px;
  border-left: 3px solid var(--line);
  color: var(--muted);
}
.chat-md hr {
  margin: 10px 0;
  border: none;
  border-top: 1px solid var(--line);
}
.chat-md table {
  border-collapse: collapse;
  margin: 6px 0;
  font-size: 12px;
  display: block;
  overflow-x: auto;
}
.chat-md th, .chat-md td {
  border: 1px solid var(--line);
  padding: 4px 8px;
  text-align: left;
}
.chat-md th { background: var(--panel-2); font-weight: 600; }
.chat-md img { max-width: 100%; height: auto; border-radius: 4px; }
`;

function TypingDots() {
  const dot: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--dim)',
    animation: 'chat-typing 1.2s infinite ease-in-out',
  };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 18,
      }}
    >
      <style>
        {`@keyframes chat-typing { 0%,80%,100%{opacity:.25;transform:translateY(0)} 40%{opacity:1;transform:translateY(-2px)} }
        .chat-typing-d2{animation-delay:.15s}
        .chat-typing-d3{animation-delay:.3s}`}
      </style>
      <span style={dot} />
      <span style={dot} className="chat-typing-d2" />
      <span style={dot} className="chat-typing-d3" />
    </span>
  );
}

function Caret() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 6,
        height: 14,
        marginLeft: 2,
        verticalAlign: '-2px',
        background: 'var(--dim)',
        animation: 'chat-caret 1s steps(2, end) infinite',
      }}
    >
      <style>
        {`@keyframes chat-caret { 0%,50%{opacity:1} 51%,100%{opacity:0} }`}
      </style>
    </span>
  );
}

const LINE_HEIGHT = 18;
const COMPOSER_LINES = 4;
const COMPOSER_PADDING_Y = 16; // top + bottom padding inside textarea
const MAX_TEXTAREA_HEIGHT = LINE_HEIGHT * COMPOSER_LINES + COMPOSER_PADDING_Y;
const MIN_TEXTAREA_HEIGHT = LINE_HEIGHT + COMPOSER_PADDING_Y;

function Composer({ tabId, disabled }: { tabId: string; disabled: boolean }) {
  const { sendMessage } = useChatPanel();
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

  const canSend = !disabled && value.trim().length > 0;

  function send() {
    if (!canSend) return;
    const text = value.trim();
    setValue('');
    void sendMessage(tabId, text);
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
        placeholder={disabled ? 'Waiting for reply…' : 'Message…'}
        disabled={disabled}
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
          opacity: disabled ? 0.6 : 1,
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

type IconButtonProps = {
  icon: 'plus' | 'clock' | 'chevron' | 'x' | 'panelRight';
  label: string;
  onClick: () => void;
  rotate?: number;
  ref?: RefObject<HTMLButtonElement | null>;
};

function IconButton({ icon, label, onClick, rotate, ref }: IconButtonProps) {
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
      ref={ref}
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
