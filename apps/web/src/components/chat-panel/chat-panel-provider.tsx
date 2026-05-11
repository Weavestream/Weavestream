'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  createChatConversation,
  deleteChatConversation,
  getChatConversation,
} from '../../lib/chat-api';
import { streamChatMessage, type ChatStreamMeta } from '../../lib/chat-stream';

export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  pending?: boolean;
  error?: string;
};

export type ChatTabKind = 'freeform' | 'context';

export type ChatTab = {
  id: string;
  /** Server conversation id, or null until the first turn is committed. */
  conversationId: string | null;
  kind: ChatTabKind;
  title: string;
  icon: 'chat' | 'doc';
  messages: ChatMessage[];
  /** True while we're loading historical messages for this tab. */
  loading: boolean;
  /** Assistant message id that is currently being streamed into, if any. */
  streamingMessageId: string | null;
};

type State = {
  isOpen: boolean;
  isMinimized: boolean;
  width: number;
  tabs: ChatTab[];
  activeTabId: string | null;
  freeformCounter: number;
};

type Action =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'toggle' }
  | { type: 'toggleMinimized' }
  | { type: 'setWidth'; width: number }
  | { type: 'addFreeformTab' }
  | { type: 'addLoadedTab'; tab: ChatTab }
  | { type: 'closeTab'; id: string }
  | { type: 'setActiveTab'; id: string }
  | {
      type: 'sendStart';
      tabId: string;
      userMsgId: string;
      assistantMsgId: string;
      text: string;
    }
  | {
      type: 'sendMeta';
      tabId: string;
      optimisticUserId: string;
      optimisticAssistantId: string;
      meta: ChatStreamMeta;
    }
  | { type: 'sendDelta'; tabId: string; assistantMsgId: string; chunk: string }
  | { type: 'setTabTitle'; tabId: string; title: string }
  | { type: 'sendDone'; tabId: string; assistantMsgId: string }
  | {
      type: 'sendError';
      tabId: string;
      assistantMsgId: string;
      message: string;
    };

export const MIN_WIDTH = 220;
export const MAX_WIDTH = 600;
export const DEFAULT_WIDTH = 320;
const WIDTH_KEY = 'chatPanel.width';
const OPEN_KEY = 'chatPanel.isOpen';

function clampWidth(w: number): number {
  if (Number.isNaN(w)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
}

function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function newFreeformTab(n: number): ChatTab {
  return {
    id: newId(),
    conversationId: null,
    kind: 'freeform',
    title: `New chat ${n}`,
    icon: 'chat',
    messages: [],
    loading: false,
    streamingMessageId: null,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'open':
      if (state.isOpen) return state;
      if (state.tabs.length === 0) {
        const t = newFreeformTab(state.freeformCounter);
        return {
          ...state,
          isOpen: true,
          tabs: [t],
          activeTabId: t.id,
          freeformCounter: state.freeformCounter + 1,
        };
      }
      return { ...state, isOpen: true };
    case 'close':
      return { ...state, isOpen: false };
    case 'toggle':
      return reducer(state, { type: state.isOpen ? 'close' : 'open' });
    case 'toggleMinimized':
      return { ...state, isMinimized: !state.isMinimized };
    case 'setWidth':
      return { ...state, width: clampWidth(action.width) };
    case 'addFreeformTab': {
      const t = newFreeformTab(state.freeformCounter);
      return {
        ...state,
        tabs: [...state.tabs, t],
        activeTabId: t.id,
        freeformCounter: state.freeformCounter + 1,
        isMinimized: false,
      };
    }
    case 'addLoadedTab':
      return {
        ...state,
        tabs: [...state.tabs, action.tab],
        activeTabId: action.tab.id,
        isMinimized: false,
      };
    case 'closeTab': {
      const idx = state.tabs.findIndex((t) => t.id === action.id);
      if (idx < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      let activeTabId = state.activeTabId;
      if (state.activeTabId === action.id) {
        if (tabs.length === 0) {
          activeTabId = null;
        } else {
          const nextIdx = Math.min(Math.max(0, idx - 1), tabs.length - 1);
          const next = tabs[nextIdx];
          activeTabId = next ? next.id : null;
        }
      }
      return { ...state, tabs, activeTabId };
    }
    case 'setActiveTab':
      if (!state.tabs.some((t) => t.id === action.id)) return state;
      return { ...state, activeTabId: action.id };
    case 'sendStart':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId
            ? {
                ...t,
                streamingMessageId: action.assistantMsgId,
                messages: [
                  ...t.messages,
                  {
                    id: action.userMsgId,
                    role: 'user',
                    text: action.text,
                  },
                  {
                    id: action.assistantMsgId,
                    role: 'assistant',
                    text: '',
                    pending: true,
                  },
                ],
              }
            : t,
        ),
      };
    case 'sendMeta':
      return {
        ...state,
        tabs: state.tabs.map((t) => {
          if (t.id !== action.tabId) return t;
          return {
            ...t,
            conversationId: action.meta.conversationId,
            title: action.meta.title || t.title,
            // Remap the optimistic ids to the canonical server ids so
            // subsequent `sendDelta` events target the same row that
            // a later page reload would render from the database.
            streamingMessageId: action.meta.assistantMessageId,
            messages: t.messages.map((m) => {
              if (m.id === action.optimisticUserId) {
                return { ...m, id: action.meta.userMessageId };
              }
              if (m.id === action.optimisticAssistantId) {
                return { ...m, id: action.meta.assistantMessageId };
              }
              return m;
            }),
          };
        }),
      };
    case 'sendDelta':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === action.assistantMsgId
                    ? { ...m, text: m.text + action.chunk, pending: true }
                    : m,
                ),
              }
            : t,
        ),
      };
    case 'setTabTitle':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId && action.title.length > 0
            ? { ...t, title: action.title }
            : t,
        ),
      };
    case 'sendDone':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId
            ? {
                ...t,
                streamingMessageId: null,
                messages: t.messages.map((m) =>
                  m.id === action.assistantMsgId
                    ? { ...m, pending: false }
                    : m,
                ),
              }
            : t,
        ),
      };
    case 'sendError':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId
            ? {
                ...t,
                streamingMessageId: null,
                messages: t.messages.map((m) =>
                  m.id === action.assistantMsgId
                    ? {
                        ...m,
                        pending: false,
                        error: action.message,
                      }
                    : m,
                ),
              }
            : t,
        ),
      };
    default:
      return state;
  }
}

type Ctx = {
  state: State;
  open: () => void;
  close: () => void;
  toggle: () => void;
  toggleMinimized: () => void;
  setWidth: (w: number) => void;
  addFreeformTab: () => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  sendMessage: (tabId: string, text: string) => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  activeTab: ChatTab | null;
};

const ChatPanelContext = createContext<Ctx | null>(null);

export function useChatPanel(): Ctx {
  const v = useContext(ChatPanelContext);
  if (!v) {
    const noop = () => {};
    const asyncNoop = async () => {};
    return {
      state: {
        isOpen: false,
        isMinimized: false,
        width: DEFAULT_WIDTH,
        tabs: [],
        activeTabId: null,
        freeformCounter: 1,
      },
      open: noop,
      close: noop,
      toggle: noop,
      toggleMinimized: noop,
      setWidth: noop,
      addFreeformTab: noop,
      closeTab: noop,
      setActiveTab: noop,
      sendMessage: asyncNoop,
      openConversation: asyncNoop,
      deleteConversation: asyncNoop,
      activeTab: null,
    };
  }
  return v;
}

export function ChatPanelProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    isOpen: false,
    isMinimized: false,
    width: DEFAULT_WIDTH,
    tabs: [],
    activeTabId: null,
    freeformCounter: 1,
  }));

  // Active stream aborts per tab. Closing a tab or sending a new
  // message before the previous one settled cancels the in-flight
  // fetch so the server can stop talking to the LLM.
  const aborts = useRef(new Map<string, AbortController>());

  // Latest state for callbacks that need to peek inside without
  // refiring as dependencies — the callbacks themselves stay stable.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    try {
      const w = window.localStorage.getItem(WIDTH_KEY);
      if (w) {
        const n = parseInt(w, 10);
        if (Number.isFinite(n)) dispatch({ type: 'setWidth', width: n });
      }
      const o = window.localStorage.getItem(OPEN_KEY);
      if (o === '1') dispatch({ type: 'open' });
    } catch {
      // localStorage may be unavailable (private mode / SSR). Safe to ignore.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(state.width));
    } catch {
      // ignore
    }
  }, [state.width]);

  useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_KEY, state.isOpen ? '1' : '0');
    } catch {
      // ignore
    }
  }, [state.isOpen]);

  // Cancel all in-flight streams on unmount (e.g. route change).
  useEffect(() => {
    const map = aborts.current;
    return () => {
      for (const ctrl of map.values()) ctrl.abort();
      map.clear();
    };
  }, []);

  const sendMessage = useCallback(async (tabId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const tab = stateRef.current.tabs.find((t) => t.id === tabId);
    if (!tab || tab.streamingMessageId) return;

    let conversationId = tab.conversationId;
    if (!conversationId) {
      const created = await createChatConversation();
      if (!created) {
        const optimisticAssistantId = newId();
        dispatch({
          type: 'sendStart',
          tabId,
          userMsgId: newId(),
          assistantMsgId: optimisticAssistantId,
          text: trimmed,
        });
        dispatch({
          type: 'sendError',
          tabId,
          assistantMsgId: optimisticAssistantId,
          message: 'Could not create conversation. Are you signed in?',
        });
        return;
      }
      conversationId = created.id;
    }

    const optimisticUserId = newId();
    const optimisticAssistantId = newId();
    dispatch({
      type: 'sendStart',
      tabId,
      userMsgId: optimisticUserId,
      assistantMsgId: optimisticAssistantId,
      text: trimmed,
    });

    // The message id may be rewritten by the `meta` frame from the
    // server. Keep a mutable reference so subsequent delta/done/error
    // dispatches target the right row whether or not we got `meta`
    // yet (some adapters delay the first frame).
    const activeAssistantId = { current: optimisticAssistantId };
    const ctrl = new AbortController();
    aborts.current.set(tabId, ctrl);

    await streamChatMessage(
      conversationId,
      trimmed,
      {
        onMeta: (meta) => {
          activeAssistantId.current = meta.assistantMessageId;
          dispatch({
            type: 'sendMeta',
            tabId,
            optimisticUserId,
            optimisticAssistantId,
            meta,
          });
        },
        onDelta: (chunk) => {
          dispatch({
            type: 'sendDelta',
            tabId,
            assistantMsgId: activeAssistantId.current,
            chunk,
          });
        },
        onTitle: (title) => {
          dispatch({ type: 'setTabTitle', tabId, title });
        },
        onDone: () => {
          dispatch({
            type: 'sendDone',
            tabId,
            assistantMsgId: activeAssistantId.current,
          });
        },
        onError: (message) => {
          dispatch({
            type: 'sendError',
            tabId,
            assistantMsgId: activeAssistantId.current,
            message,
          });
        },
      },
      ctrl.signal,
    );
    aborts.current.delete(tabId);
  }, []);

  const openConversation = useCallback(async (id: string) => {
    const existing = stateRef.current.tabs.find((t) => t.conversationId === id);
    if (existing) {
      dispatch({ type: 'setActiveTab', id: existing.id });
      return;
    }
    const detail = await getChatConversation(id);
    if (!detail) return;
    const tab: ChatTab = {
      id: newId(),
      conversationId: detail.id,
      kind: 'freeform',
      title: detail.title,
      icon: 'chat',
      messages: detail.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.content,
      })),
      loading: false,
      streamingMessageId: null,
    };
    dispatch({ type: 'addLoadedTab', tab });
  }, []);

  const deleteConversation = useCallback(async (id: string) => {
    const ok = await deleteChatConversation(id);
    if (!ok) return;
    const matching = stateRef.current.tabs.find((t) => t.conversationId === id);
    if (matching) {
      const ctrl = aborts.current.get(matching.id);
      ctrl?.abort();
      aborts.current.delete(matching.id);
      dispatch({ type: 'closeTab', id: matching.id });
    }
  }, []);

  const value = useMemo<Ctx>(() => {
    const activeTab =
      state.tabs.find((t) => t.id === state.activeTabId) ?? null;
    return {
      state,
      activeTab,
      open: () => dispatch({ type: 'open' }),
      close: () => dispatch({ type: 'close' }),
      toggle: () => dispatch({ type: 'toggle' }),
      toggleMinimized: () => dispatch({ type: 'toggleMinimized' }),
      setWidth: (w: number) => dispatch({ type: 'setWidth', width: w }),
      addFreeformTab: () => dispatch({ type: 'addFreeformTab' }),
      closeTab: (id: string) => {
        const ctrl = aborts.current.get(id);
        ctrl?.abort();
        aborts.current.delete(id);
        dispatch({ type: 'closeTab', id });
      },
      setActiveTab: (id: string) => dispatch({ type: 'setActiveTab', id }),
      sendMessage,
      openConversation,
      deleteConversation,
    };
  }, [state, sendMessage, openConversation, deleteConversation]);

  return (
    <ChatPanelContext.Provider value={value}>
      {children}
    </ChatPanelContext.Provider>
  );
}
