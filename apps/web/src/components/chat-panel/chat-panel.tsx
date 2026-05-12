'use client';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon, type IconComponent } from '../ui';
import {
  useChatPanel,
  type ChatMessage,
  type ChatTab,
} from './chat-panel-provider';
import { ResizeHandle } from './resize-handle';
import { ChatHistoryPopover } from './chat-history-popover';
import { ChatContextStrip } from './chat-context-strip';
import { MentionPicker, type MentionCandidate } from './mention-picker';
import { ToolCallCard } from './tool-call-card';
import { SaveAsArticleDialog } from './save-as-article-dialog';

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
        <MessageList tab={tab} />
      )}
      <ChatContextStrip tab={tab} />
      {/* keyed on tab.id so the draft + autosize reset when switching tabs */}
      <Composer
        key={tab.id}
        tab={tab}
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

function MessageList({ tab }: { tab: ChatTab }) {
  const messages = tab.messages;
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
        gap: 12,
      }}
    >
      {messages.map((m) => (
        <MessageBubble key={m.id} tab={tab} message={m} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({
  tab,
  message,
}: {
  tab: ChatTab;
  message: ChatMessage;
}) {
  const isUser = message.role === 'user';
  const hasError = !!message.error;
  const toolCalls = message.toolCalls ?? [];
  // Many OpenAI-compatible servers (Ollama, llama.cpp, vLLM with some
  // chat templates) emit a leading `\n` or `\n\n` before the real
  // content. `whiteSpace: pre-wrap` faithfully renders that as an
  // empty line at the top of the bubble — visually it looks like the
  // bubble has spurious top padding. Strip leading whitespace at the
  // bubble level so historical and streaming messages look identical.
  const displayText = isUser ? message.text : message.text.replace(/^\s+/, '');
  const isEmptyPending =
    message.pending && displayText.length === 0 && !hasError;
  // Two distinct bubble styles. User: a compact, accent-tinted chip
  // pinned to the right with a border. Assistant: a borderless,
  // full-width block that lets prose / code / tables breathe in a
  // narrow panel — no background fill so the panel chrome itself
  // acts as the container.
  const bubble: CSSProperties = isUser
    ? {
        maxWidth: '85%',
        padding: '8px 10px',
        borderRadius: 8,
        fontSize: 13,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        border: '1px solid var(--line)',
        background: hasError
          ? 'color-mix(in oklch, var(--danger, #c0392b) 12%, var(--panel))'
          : 'color-mix(in oklch, var(--accent) 18%, var(--panel))',
        color: 'var(--text)',
        alignSelf: 'flex-end',
      }
    : {
        alignSelf: 'stretch',
        width: '100%',
        padding: '2px 0 6px',
        fontSize: 13,
        lineHeight: 1.5,
        whiteSpace: 'normal',
        wordBreak: 'break-word',
        color: hasError ? 'var(--danger, #c0392b)' : 'var(--text)',
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
      {isUser ? renderUserText(displayText) : <AssistantMarkdown text={displayText} />}
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
      {!isUser && toolCalls.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            marginTop: 10,
          }}
        >
          {toolCalls.map((tc) => (
            <ToolCallCard
              key={tc.id}
              tab={tab}
              messageId={message.id}
              toolCall={tc}
            />
          ))}
        </div>
      )}
      {!isUser && !message.pending && !hasError && displayText.length > 0 && (
        <AssistantActions markdown={displayText} />
      )}
    </div>
  );
}

/**
 * Inline action row below a completed assistant message — copy the
 * raw markdown to the clipboard, or open a confirmation dialog that
 * turns the response into a brand-new article in the user's chosen
 * company / folder. We always offer the actions on settled assistant
 * turns regardless of any inline tool-call cards, since the actions
 * target the response text itself, not the model's proposals.
 */
function AssistantActions({ markdown }: { markdown: string }) {
  const { state } = useChatPanel();
  const defaultCompanyId = state.pageContext?.companyId ?? null;
  const [copied, setCopied] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  async function onCopy() {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(markdown);
      } else {
        const ta = document.createElement('textarea');
        ta.value = markdown;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Best-effort copy — ignore failures (older browsers / blocked perms).
    }
  }

  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 4,
          marginTop: 8,
          alignItems: 'center',
          opacity: 0.85,
        }}
      >
        <ActionButton
          icon={copied ? Icon.check : Icon.copy}
          label={copied ? 'Copied' : 'Copy'}
          onClick={onCopy}
          title="Copy response to clipboard"
        />
        <ActionButton
          icon={Icon.doc}
          label="Save as article"
          onClick={() => setSaveOpen(true)}
          title="Create a new article from this response"
        />
      </div>
      <SaveAsArticleDialog
        open={saveOpen}
        markdown={markdown}
        defaultCompanyId={defaultCompanyId}
        onClose={() => setSaveOpen(false)}
      />
    </>
  );
}

function ActionButton({
  icon: I,
  label,
  onClick,
  title,
}: {
  icon: IconComponent;
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 24,
        padding: '0 8px',
        border: '1px solid var(--line)',
        borderRadius: 5,
        background: 'transparent',
        color: 'var(--muted)',
        fontSize: 11.5,
        cursor: 'pointer',
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--panel-2)';
        e.currentTarget.style.color = 'var(--text)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'var(--muted)';
      }}
    >
      <I size={11} />
      <span>{label}</span>
    </button>
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
        remarkPlugins={[remarkGfm, remarkChatReference]}
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

/**
 * Remark plugin that turns `@[Title]` reference tokens into inline
 * `<span class="chat-ref">@Title</span>` nodes so the assistant markdown
 * renderer doesn't fall through to markdown's reference-link syntax
 * (which would leave the brackets visible and emit a stray link).
 * Skips code blocks and inline code so prose-only tokens aren't
 * rewritten inside a snippet.
 */
function remarkChatReference() {
  return (tree: unknown) => walk(tree as MdastNode);
}

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

function walk(node: MdastNode): void {
  if (!node.children) return;
  const next: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'inlineCode' || child.type === 'code') {
      next.push(child);
      continue;
    }
    if (child.type === 'text' && typeof child.value === 'string') {
      const segments = splitReferenceText(child.value);
      if (segments) {
        next.push(...segments);
        continue;
      }
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
}

function splitReferenceText(value: string): MdastNode[] | null {
  const re = /@\[([^\]]+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const out: MdastNode[] = [];
  while ((match = re.exec(value)) !== null) {
    if (match.index > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }
    out.push({
      type: 'chatReference',
      data: { hName: 'span', hProperties: { className: 'chat-ref' } },
      children: [{ type: 'text', value: `@${match[1]}` }],
    });
    lastIndex = match.index + match[0].length;
  }
  if (out.length === 0) return null;
  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
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
.chat-md .chat-ref {
  color: var(--accent);
  font-weight: 500;
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
  font-size: 12px;
  line-height: 1.4;
}
.chat-md pre code {
  background: transparent;
  border: none;
  padding: 0;
  border-radius: 0;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
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
  /* Cancel the bubble's word-break inside tables so headers like
     "Mission" don't get sliced into "Missio / n" when the auto-
     layout algorithm tries to satisfy a narrow container. Long
     content cells still wrap naturally on whitespace. */
  word-break: normal;
  overflow-wrap: normal;
}
.chat-md th, .chat-md td {
  border: 1px solid var(--line);
  padding: 4px 8px;
  text-align: left;
  vertical-align: top;
}
.chat-md th {
  background: var(--panel-2);
  font-weight: 600;
  /* Headers must stay on one line so the column is sized to the
     header label; if the resulting table exceeds the bubble width,
     the table's overflow-x: auto provides horizontal scroll. */
  white-space: nowrap;
}
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

// `@[Title]` reference tokens, inserted by the composer when a user
// picks an article from the @-mention picker. The brackets are stripped
// at render time; the title is shown in the accent color.
const REFERENCE_TOKEN_RE = /@\[([^\]]+)\]/g;

function renderUserText(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  REFERENCE_TOKEN_RE.lastIndex = 0;
  while ((match = REFERENCE_TOKEN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span
        key={`ref-${match.index}`}
        style={{ color: 'var(--accent)', fontWeight: 500 }}
      >
        @{match[1]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : text;
}

function parseReferenceTitles(text: string): Set<string> {
  const out = new Set<string>();
  REFERENCE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REFERENCE_TOKEN_RE.exec(text)) !== null) out.add(m[1]!);
  return out;
}

const LINE_HEIGHT = 18;
const COMPOSER_LINES = 4;
const COMPOSER_PADDING_Y = 16; // top + bottom padding inside textarea
const MAX_TEXTAREA_HEIGHT = LINE_HEIGHT * COMPOSER_LINES + COMPOSER_PADDING_Y;
const MIN_TEXTAREA_HEIGHT = LINE_HEIGHT + COMPOSER_PADDING_Y;

// The composer renders the textarea with transparent text and an
// absolutely-positioned mirror div underneath, so `@[Title]` reference
// tokens can be drawn in the accent color while the textarea still
// handles input + caret. The placeholder rule keeps the hint visible
// when the textarea's text color is transparent.
const COMPOSER_STYLES = `
.chat-composer-textarea::placeholder { color: var(--dim); opacity: 1; }
.chat-composer-textarea::-webkit-input-placeholder { color: var(--dim); }
`;

function renderComposerHighlight(text: string): ReactNode {
  // `pre-wrap` doesn't render a trailing newline as an extra blank
  // line; the textarea does. Append a zero-width space after a trailing
  // newline so the mirror grows in lockstep when the user is on a new
  // empty line.
  const trailing = text.endsWith('\n') ? '​' : '';
  const nodes = renderUserText(text);
  if (Array.isArray(nodes)) return [...nodes, trailing];
  return trailing ? [nodes, trailing] : nodes;
}

function Composer({ tab, disabled }: { tab: ChatTab; disabled: boolean }) {
  const { state, sendMessage, addMention, removeMention } = useChatPanel();
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const tabId = tab.id;
  // Prefer the article page snapshot's companyId (preserves tool-call
  // scoping behavior) but fall back to the company shell's broadcast
  // so the picker is available on every company-scoped page, not just
  // article view / edit.
  const companyId =
    state.pageContext?.companyId ?? state.companyContext?.companyId ?? null;

  // @-mention picker state. `query` is the substring after the active
  // `@` and `tokenStart` is the index of that `@` in `value`.
  const [mentionTokenStart, setMentionTokenStart] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState('');
  const pageArticleId = state.pageContext?.articleId ?? null;
  const mentions = tab.mentions;
  const excludeIds = useMemo(() => {
    const s = new Set<string>();
    if (pageArticleId) s.add(pageArticleId);
    for (const m of mentions) s.add(m.id);
    return s;
  }, [pageArticleId, mentions]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.min(MAX_TEXTAREA_HEIGHT, Math.max(MIN_TEXTAREA_HEIGHT, ta.scrollHeight));
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
    // Keep the highlight overlay's scroll position in lockstep with the
    // textarea after the height/content change.
    if (overlayRef.current) overlayRef.current.scrollTop = ta.scrollTop;
  }, [value]);

  const canSend = !disabled && value.trim().length > 0;

  function send() {
    if (!canSend) return;
    const text = value.trim();
    setValue('');
    setMentionTokenStart(null);
    void sendMessage(tabId, text);
  }

  /**
   * Inspect the cursor position after every change. We're looking for
   * an `@` token that:
   *   - starts at the beginning of the input or after whitespace
   *   - hasn't been closed by a space (since selection)
   *   - has 0–40 chars after it (the substring is the query)
   * When found, open the picker; when broken (space, deletion past
   * the `@`, etc.) close it.
   */
  function detectMentionTrigger(nextValue: string, caret: number) {
    if (!companyId) {
      setMentionTokenStart(null);
      return;
    }
    let i = caret - 1;
    while (i >= 0 && nextValue[i] !== '@' && !/\s/.test(nextValue[i]!)) {
      i--;
      if (caret - i > 41) {
        setMentionTokenStart(null);
        return;
      }
    }
    if (i < 0 || nextValue[i] !== '@') {
      setMentionTokenStart(null);
      return;
    }
    if (i > 0 && !/\s/.test(nextValue[i - 1]!)) {
      setMentionTokenStart(null);
      return;
    }
    setMentionTokenStart(i);
    setMentionQuery(nextValue.slice(i + 1, caret));
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setValue(next);
    detectMentionTrigger(next, e.target.selectionStart ?? next.length);
    // If the user deleted an `@[Title]` token from the textarea, drop
    // the matching mention from `tab.mentions` so the request context
    // and the inline reference stay in sync.
    const tokenTitles = parseReferenceTitles(next);
    for (const m of mentions) {
      if (!tokenTitles.has(m.title)) removeMention(tabId, m.id);
    }
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      detectMentionTrigger(value, e.currentTarget.selectionStart ?? value.length);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // If the picker is open, it consumes Arrow/Enter/Escape via its
    // own global keydown listener (added with capture: true), so we
    // only handle the bare Enter→send path when the picker is closed.
    if (mentionTokenStart !== null) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function handleMentionPick(item: MentionCandidate) {
    if (mentionTokenStart === null) return;
    addMention(tabId, { kind: item.kind, id: item.id, title: item.title });
    // Replace the active `@…` token with an `@[Title]` reference token.
    // The token survives in the persisted message text and is rendered
    // with the accent color in the user bubble (see `renderUserText`).
    // The bracket only carries display text; the kind is tracked on
    // `tab.mentions` so we know which endpoint to hit at send time.
    const before = value.slice(0, mentionTokenStart);
    const afterStart = mentionTokenStart + 1 + mentionQuery.length;
    const after = value.slice(afterStart);
    const token = `@[${item.title}]`;
    const needsLeadingSpace =
      before.length > 0 && !/\s$/.test(before);
    const trailing = after.startsWith(' ') ? '' : ' ';
    const next = `${before}${needsLeadingSpace ? ' ' : ''}${token}${trailing}${after}`;
    const caret =
      before.length + (needsLeadingSpace ? 1 : 0) + token.length + trailing.length;
    setValue(next);
    setMentionTokenStart(null);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
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
      <div
        style={{
          position: 'relative',
          flex: 1,
          border: '1px solid var(--line)',
          borderRadius: 6,
          background: 'var(--surface)',
          overflow: 'hidden',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <style>{COMPOSER_STYLES}</style>
        <div
          ref={overlayRef}
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            padding: '8px 10px',
            boxSizing: 'border-box',
            color: 'var(--text)',
            fontSize: 13,
            lineHeight: `${LINE_HEIGHT}px`,
            fontFamily: 'inherit',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {renderComposerHighlight(value)}
        </div>
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onScroll={(e) => {
            if (overlayRef.current) {
              overlayRef.current.scrollTop = e.currentTarget.scrollTop;
            }
          }}
          onClick={(e) =>
            detectMentionTrigger(
              value,
              (e.currentTarget as HTMLTextAreaElement).selectionStart ?? value.length,
            )
          }
          placeholder={
            disabled
              ? 'Waiting for reply…'
              : companyId
                ? 'Message…  (type @ to attach an article or asset)'
                : 'Message…'
          }
          disabled={disabled}
          className="chat-composer-textarea"
          style={{
            display: 'block',
            position: 'relative',
            width: '100%',
            resize: 'none',
            padding: '8px 10px',
            boxSizing: 'border-box',
            border: 'none',
            background: 'transparent',
            color: 'transparent',
            caretColor: 'var(--text)',
            fontSize: 13,
            lineHeight: `${LINE_HEIGHT}px`,
            minHeight: MIN_TEXTAREA_HEIGHT,
            maxHeight: MAX_TEXTAREA_HEIGHT,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
      </div>
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
      {mentionTokenStart !== null && companyId && (
        <MentionPicker
          anchorRef={taRef}
          companyId={companyId}
          query={mentionQuery}
          excludeIds={excludeIds}
          onSelect={handleMentionPick}
          onClose={() => setMentionTokenStart(null)}
        />
      )}
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
