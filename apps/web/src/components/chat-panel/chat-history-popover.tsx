'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import type { ChatConversationSummary } from '@weavestream/shared';
import { Icon } from '../ui';
import { listChatConversations } from '../../lib/chat-api';
import { useChatPanel } from './chat-panel-provider';

const POPOVER_WIDTH = 300;
const POPOVER_MAX_HEIGHT = 420;

/**
 * Cursor-style chat history popover: a single-line row per
 * conversation, grouped by recency (Today / Yesterday / Previous 7
 * days / Older). Delete affordance appears on hover only so the
 * default state is calm. Outside-click + Escape dismiss.
 */
export function ChatHistoryPopover({
  anchorRef,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { openConversation, deleteConversation } = useChatPanel();
  const [items, setItems] = useState<ChatConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await listChatConversations();
        if (alive) setItems(data);
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : 'Could not load history');
          setItems([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const top = r.bottom + 4;
    let left = r.right - POPOVER_WIDTH;
    if (left < 8) left = 8;
    if (top + POPOVER_MAX_HEIGHT > window.innerHeight) {
      setPosition({
        top: Math.max(8, r.top - POPOVER_MAX_HEIGHT - 4),
        left,
      });
      return;
    }
    setPosition({ top, left });
  }, [anchorRef]);

  useEffect(() => {
    function onDocClick(e: globalThis.MouseEvent) {
      const target = e.target as Node;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const handleOpen = useCallback(
    async (id: string) => {
      onClose();
      await openConversation(id);
    },
    [onClose, openConversation],
  );

  const handleDelete = useCallback(
    async (e: MouseEvent, id: string) => {
      e.stopPropagation();
      setItems((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
      const ok = await deleteConversation(id).then(
        () => true,
        () => false,
      );
      if (!ok) {
        const fresh = await listChatConversations();
        setItems(fresh);
      }
    },
    [deleteConversation],
  );

  const groups = useMemo(() => groupByRecency(items ?? []), [items]);

  if (!position) return null;

  const wrap: CSSProperties = {
    position: 'fixed',
    top: position.top,
    left: position.left,
    width: POPOVER_WIDTH,
    maxHeight: POPOVER_MAX_HEIGHT,
    background: 'var(--panel)',
    border: '1px solid var(--line)',
    borderRadius: 10,
    boxShadow: '0 12px 32px rgba(0,0,0,0.22)',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  return (
    <div ref={popRef} style={wrap} role="dialog" aria-label="Chat history">
      <style>{ROW_STYLES}</style>
      <div
        className="scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '6px 0',
        }}
      >
        {items === null ? (
          <PopoverNotice>Loading…</PopoverNotice>
        ) : items.length === 0 ? (
          <PopoverNotice>
            {error ?? 'No conversations yet. Send a message to start one.'}
          </PopoverNotice>
        ) : (
          groups.map((g) => (
            <Section key={g.label} label={g.label}>
              {g.items.map((c) => (
                <HistoryRow
                  key={c.id}
                  item={c}
                  onOpen={() => handleOpen(c.id)}
                  onDelete={(e) => handleDelete(e, c.id)}
                />
              ))}
            </Section>
          ))
        )}
      </div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: '2px 0' }}>
      <div
        style={{
          padding: '4px 12px 2px',
          fontSize: 11,
          color: 'var(--dim)',
          letterSpacing: 0.2,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function HistoryRow({
  item,
  onOpen,
  onDelete,
}: {
  item: ChatConversationSummary;
  onOpen: () => void;
  onDelete: (e: MouseEvent) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="chat-history-row"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <Icon.chat
        size={12}
        style={{ color: 'var(--dim)', flexShrink: 0 }}
      />
      <span className="chat-history-row__title" title={item.title}>
        {item.title}
      </span>
      <button
        type="button"
        aria-label={`Delete ${item.title}`}
        title="Delete"
        onClick={onDelete}
        className="chat-history-row__delete"
      >
        <Icon.trash size={12} />
      </button>
    </div>
  );
}

function PopoverNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '20px 12px',
        fontSize: 12,
        color: 'var(--muted)',
        textAlign: 'center',
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

type Group = { label: string; items: ChatConversationSummary[] };

function groupByRecency(items: ChatConversationSummary[]): Group[] {
  const today: ChatConversationSummary[] = [];
  const yesterday: ChatConversationSummary[] = [];
  const week: ChatConversationSummary[] = [];
  const older: ChatConversationSummary[] = [];

  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const now = new Date();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 24 * 3600 * 1000;
  const weekStart = todayStart - 6 * 24 * 3600 * 1000;

  for (const item of items) {
    const t = new Date(item.updatedAt).getTime();
    if (Number.isNaN(t)) {
      older.push(item);
      continue;
    }
    if (t >= todayStart) today.push(item);
    else if (t >= yesterdayStart) yesterday.push(item);
    else if (t >= weekStart) week.push(item);
    else older.push(item);
  }

  const out: Group[] = [];
  if (today.length) out.push({ label: 'Today', items: today });
  if (yesterday.length) out.push({ label: 'Yesterday', items: yesterday });
  if (week.length) out.push({ label: 'Previous 7 days', items: week });
  if (older.length) out.push({ label: 'Older', items: older });
  return out;
}

// Inline stylesheet: hover background + reveal-on-hover delete button.
// Scoped via the `.chat-history-row` class so the rules don't bleed
// into the rest of the app.
const ROW_STYLES = `
.chat-history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px 3px 12px;
  margin: 0 4px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text);
  line-height: 1.2;
}
.chat-history-row:hover,
.chat-history-row:focus-visible {
  background: var(--surface);
  outline: none;
}
.chat-history-row__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-history-row__delete {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--dim);
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 120ms ease;
}
.chat-history-row:hover .chat-history-row__delete,
.chat-history-row:focus-within .chat-history-row__delete,
.chat-history-row__delete:focus-visible {
  opacity: 1;
}
.chat-history-row__delete:hover {
  color: var(--text);
  background: var(--panel-2);
}
`;
