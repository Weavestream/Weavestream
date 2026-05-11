'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';

export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
};

export type ChatTabKind = 'freeform' | 'context';

export type ChatTab = {
  id: string;
  kind: ChatTabKind;
  title: string;
  icon: 'chat' | 'doc';
  messages: ChatMessage[];
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
  | { type: 'closeTab'; id: string }
  | { type: 'setActiveTab'; id: string }
  | { type: 'appendUserMessage'; tabId: string; text: string };

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

function seedFreeformTab(n: number): ChatTab {
  const id = newId();
  return {
    id,
    kind: 'freeform',
    title: `Chat ${n}`,
    icon: 'chat',
    messages: [
      {
        id: newId(),
        role: 'assistant',
        text: "Hi! I'm your AI assistant. Ask me anything about this workspace.",
      },
      {
        id: newId(),
        role: 'user',
        text: 'What can you help with?',
      },
      {
        id: newId(),
        role: 'assistant',
        text: 'I can summarize articles, draft password notes, and answer questions about your assets. Try sending a message below.',
      },
    ],
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'open':
      if (state.isOpen) return state;
      if (state.tabs.length === 0) {
        const t = seedFreeformTab(state.freeformCounter);
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
      const t = seedFreeformTab(state.freeformCounter);
      return {
        ...state,
        tabs: [...state.tabs, t],
        activeTabId: t.id,
        freeformCounter: state.freeformCounter + 1,
        isMinimized: false,
      };
    }
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
    case 'appendUserMessage': {
      const tabs = state.tabs.map((t) =>
        t.id === action.tabId
          ? {
              ...t,
              messages: [
                ...t.messages,
                { id: newId(), role: 'user' as const, text: action.text },
              ],
            }
          : t,
      );
      return { ...state, tabs };
    }
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
  appendUserMessage: (tabId: string, text: string) => void;
  activeTab: ChatTab | null;
};

const ChatPanelContext = createContext<Ctx | null>(null);

export function useChatPanel(): Ctx {
  const v = useContext(ChatPanelContext);
  if (!v) {
    const noop = () => {};
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
      appendUserMessage: noop,
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

  // Hydrate persisted prefs once on mount (client-only).
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

  // Persist width + open state.
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
      closeTab: (id: string) => dispatch({ type: 'closeTab', id }),
      setActiveTab: (id: string) => dispatch({ type: 'setActiveTab', id }),
      appendUserMessage: (tabId: string, text: string) =>
        dispatch({ type: 'appendUserMessage', tabId, text }),
    };
  }, [state]);

  return (
    <ChatPanelContext.Provider value={value}>
      {children}
    </ChatPanelContext.Provider>
  );
}
