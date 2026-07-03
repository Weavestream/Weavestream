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
import type {
  ChatRequestContext,
  ChatToolCallDto,
  ChatTurnIntent,
} from '@weavestream/shared';
import {
  applyChatToolCall,
  createChatConversation,
  deleteChatConversation,
  getChatConversation,
  rejectChatToolCall,
} from '../../lib/chat-api';
import { apiFetch } from '../../lib/api';
import { streamChatMessage, type ChatStreamMeta } from '../../lib/chat-stream';
import { tiptapDocToMarkdown } from '../../lib/article-format';
import { assetToMarkdown } from '../../lib/asset-format';
import { domainToMarkdown } from '../../lib/domain-format';
import { randomClientId } from '../../lib/client-id';
import type {
  ArticleDetail,
  AssetSummary,
  DomainCheck,
  MonitoredDomain,
} from '../../lib/server-api';

export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  pending?: boolean;
  error?: string;
  /**
   * Agentic actions the assistant proposed in this turn (Apply / Reject
   * cards in the UI). Pending stream events keep this array fresh; on
   * apply / reject the matching entry is replaced with the new status.
   */
  toolCalls?: ChatToolCallDto[];
};

export type ChatTabKind = 'freeform' | 'context';

/**
 * Pinned per-tab @-mention. The "current page" entry is stored
 * separately on `pageContext` so it can be marked as the auto-
 * attached one and cannot be removed by the user — only by leaving
 * the page. `kind` discriminates between article references (which
 * may be edited via `update_article` tool calls), asset references,
 * and domain references — both assets and domains are strictly
 * read-only context.
 */
export type ChatTabContextMention = {
  kind: 'article' | 'asset' | 'domain';
  id: string;
  title: string;
};

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
  /** Explicit @-mentioned articles + assets, in insertion order. */
  mentions: ChatTabContextMention[];
};

/**
 * Snapshot of "the page the chat panel currently sees". Set via the
 * `useChatPageContext` / `useChatAssetPageContext` hooks from article
 * or asset pages. The `getMarkdown` callback is captured each render
 * so the live editor / detail state can be sampled at send time.
 *
 * Discriminated union — the article variant is the original (saved or
 * draft) article snapshot used by `update_article` / `create_article`
 * tool calls; the asset variant is a read-only auto-attachment that
 * travels alongside the user's request as a chat asset context entry.
 */
export type ChatArticlePageContext = {
  kind: 'article';
  companyId: string;
  /** Null while the article is being authored (the "new article" page). */
  articleId: string | null;
  title: string;
  getMarkdown: () => string;
  /**
   * True when the page is an open editor with unsaved changes. The
   * Apply path uses this to warn before overwriting the form's body.
   * Default `false` when omitted.
   */
  isDirty?: boolean;
  /**
   * Hook the editor surfaces so a confirmed Apply can clear / accept
   * any in-flight autosave timer before the route refreshes.
   */
  onBeforeAiApply?: () => void;
  /**
   * Called after a successful Apply that targeted this page. The
   * form/view surface uses it to sync its own local React state to
   * the freshly-persisted body so the user sees the change without
   * needing a hard reload. Receives the body fields the LLM proposed
   * (those are what landed on disk).
   */
  onAfterAiApply?: (changes: { markdown?: string; title?: string }) => void;
};

export type ChatAssetPageContext = {
  kind: 'asset';
  companyId: string;
  assetId: string;
  /** Asset display name (e.g. "dc-sv-01"). */
  title: string;
  /** Layout name (e.g. "Server") — surfaced in pills + LLM context. */
  layoutName: string;
  /**
   * Thunk returning the asset projected to markdown (sorted, type-
   * formatted bullet list). Captured by the asset detail page using
   * the `AssetSummary` it already fetched server-side.
   */
  getMarkdown: () => string;
};

export type ChatDomainPageContext = {
  kind: 'domain';
  companyId: string;
  domainId: string;
  /** Hostname (e.g. "example.com"). */
  title: string;
  /**
   * Thunk returning the domain (+ latest WHOIS/DNS/TLS check)
   * projected to markdown via `domainToMarkdown`. Captured by the
   * admin domain detail page from the row + latest check it already
   * fetched server-side.
   */
  getMarkdown: () => string;
};

/**
 * Phase 12+ — read-only ticket page context. Captured by the
 * (global admin) ticket detail page. The ticket markdown is already
 * normalised server-side via `ticketToMarkdown` and passed in
 * verbatim — there is no live editor surface to sample, so the thunk
 * just returns the captured markdown.
 *
 * `companyId` is nullable because the global tickets surface may
 * surface a ticket whose upstream client id has no Weavestream
 * mapping — in that case the chat panel falls back to its existing
 * company picker on save (see `SaveAsArticleDialog`).
 */
export type ChatTicketPageContext = {
  kind: 'ticket';
  companyId: string | null;
  /**
   * Provider-side ticket id (opaque string — NinjaOne emits numeric
   * ids as strings, other providers may use UUIDs or short codes).
   */
  ticketId: string;
  /** Driver key the ticket came from ("ninjaone", …). */
  provider: string;
  /** Display subject. */
  title: string;
  getMarkdown: () => string;
};

export type ChatPageContextSnapshot =
  | ChatArticlePageContext
  | ChatAssetPageContext
  | ChatDomainPageContext
  | ChatTicketPageContext;

type State = {
  isOpen: boolean;
  isMinimized: boolean;
  width: number;
  tabs: ChatTab[];
  activeTabId: string | null;
  /**
   * The current page's chat snapshot, registered via
   * `useChatPageContext`. Lives at the provider level (not per-tab)
   * so navigating between pages never auto-creates a tab — tabs are
   * created only when the user explicitly clicks "+ new chat" or
   * opens a previous conversation. Every send + Apply samples this
   * value, so whichever page the user is currently on is the page
   * the LLM grounds against.
   */
  pageContext: ChatPageContextSnapshot | null;
  /**
   * Active company scope — broadcast once by `CompanyChatContext`
   * inside the company shell. Independent of `pageContext` so the
   * @-mention picker can resolve articles AND assets on any company-
   * scoped page (home, asset detail, layout list, etc.), not only
   * the article view / edit pages that register a richer
   * `pageContext`. When both are set they refer to the same
   * company; `pageContext.companyId` always wins for backwards
   * compatibility with the article tool-call scoping.
   */
  companyContext: { companyId: string } | null;
};

type Action =
  | { type: 'open' }
  | {
      /**
       * Used by the localStorage rehydration effect on every
       * `ChatPanelProvider` mount. Re-opens the panel without the
       * `open` action's "auto-create first tab" side-effect, so a
       * cross-shell route change (CompanyShell remount, etc.) doesn't
       * inject a phantom empty tab on every navigation.
       */
      type: 'restoreOpen';
    }
  | { type: 'close' }
  | { type: 'toggle' }
  | { type: 'toggleMinimized' }
  | { type: 'setWidth'; width: number }
  | { type: 'addFreeformTab' }
  | { type: 'addLoadedTab'; tab: ChatTab }
  | {
      /**
       * Bulk-restore the persisted tab list on mount. Replaces both the
       * `tabs` array and the `activeTabId` atomically so the user
       * doesn't see a half-rebuilt strip during the rehydration.
       */
      type: 'restoreTabs';
      tabs: ChatTab[];
      activeTabId: string | null;
    }
  | { type: 'closeTab'; id: string }
  | { type: 'setActiveTab'; id: string }
  | { type: 'setPageContext'; pageContext: ChatPageContextSnapshot | null }
  | { type: 'setCompanyContext'; companyContext: { companyId: string } | null }
  | { type: 'addMention'; tabId: string; mention: ChatTabContextMention }
  | { type: 'removeMention'; tabId: string; mentionId: string }
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
    }
  | {
      type: 'setMessageToolCalls';
      tabId: string;
      messageId: string;
      toolCalls: ChatToolCallDto[];
    }
  | {
      type: 'patchToolCall';
      tabId: string;
      messageId: string;
      toolCallId: string;
      next: ChatToolCallDto;
    };

export const MIN_WIDTH = 220;
export const MAX_WIDTH = 600;
export const DEFAULT_WIDTH = 320;
const WIDTH_KEY = 'chatPanel.width';
const OPEN_KEY = 'chatPanel.isOpen';
// Tab list persistence. We only stash the minimal metadata needed to
// rebuild a tab from server state on the next load — message bodies,
// tool-call results, and in-flight stream ids are intentionally NOT
// persisted. Conversations themselves already live in the chat DB so
// `getChatConversation(conversationId)` rehydrates everything visible
// in the bubble list.
const TABS_KEY = 'chatPanel.tabs';

type PersistedTab = {
  id: string;
  conversationId: string | null;
  kind: ChatTabKind;
  title: string;
  icon: 'chat' | 'doc';
  mentions: ChatTabContextMention[];
};

type PersistedTabsPayload = {
  tabs: PersistedTab[];
  activeTabId: string | null;
};

function serializeTabs(state: State): PersistedTabsPayload {
  return {
    tabs: state.tabs.map((t) => ({
      id: t.id,
      conversationId: t.conversationId,
      kind: t.kind,
      title: t.title,
      icon: t.icon,
      mentions: t.mentions,
    })),
    activeTabId: state.activeTabId,
  };
}

function readPersistedTabs(): PersistedTabsPayload | null {
  try {
    const raw = window.localStorage.getItem(TABS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as { tabs?: unknown; activeTabId?: unknown };
    if (!Array.isArray(p.tabs)) return null;
    const tabs: PersistedTab[] = [];
    for (const t of p.tabs) {
      if (!t || typeof t !== 'object') continue;
      const tt = t as Record<string, unknown>;
      if (typeof tt.id !== 'string') continue;
      const conversationId =
        typeof tt.conversationId === 'string' ? tt.conversationId : null;
      const kind: ChatTabKind = tt.kind === 'context' ? 'context' : 'freeform';
      const title = typeof tt.title === 'string' ? tt.title : 'New chat';
      const icon: 'chat' | 'doc' = tt.icon === 'doc' ? 'doc' : 'chat';
      const mentions: ChatTabContextMention[] = Array.isArray(tt.mentions)
        ? tt.mentions
            .filter(
              (m): m is Record<string, unknown> =>
                !!m &&
                typeof m === 'object' &&
                typeof (m as { id?: unknown }).id === 'string' &&
                typeof (m as { title?: unknown }).title === 'string',
            )
            .map((m) => ({
              // Pre-asset persistence entries don't carry `kind` — read as
              // article so existing tab strips keep working after the
              // migration. Domain is a later addition handled the same way.
              kind:
                m.kind === 'asset'
                  ? 'asset'
                  : m.kind === 'domain'
                    ? 'domain'
                    : 'article',
              id: String(m.id),
              title: String(m.title),
            }))
        : [];
      tabs.push({ id: tt.id, conversationId, kind, title, icon, mentions });
    }
    const activeTabId =
      typeof p.activeTabId === 'string' ? p.activeTabId : null;
    return { tabs, activeTabId };
  } catch {
    return null;
  }
}

function clampWidth(w: number): number {
  if (Number.isNaN(w)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
}

function newId(): string {
  return randomClientId();
}

function newFreeformTab(): ChatTab {
  return {
    id: newId(),
    conversationId: null,
    kind: 'freeform',
    title: 'New chat',
    icon: 'chat',
    messages: [],
    loading: false,
    streamingMessageId: null,
    mentions: [],
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'open':
      if (state.isOpen) return state;
      if (state.tabs.length === 0) {
        const t = newFreeformTab();
        return {
          ...state,
          isOpen: true,
          tabs: [t],
          activeTabId: t.id,
        };
      }
      return { ...state, isOpen: true };
    case 'restoreOpen':
      if (state.isOpen) return state;
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
      const t = newFreeformTab();
      return {
        ...state,
        tabs: [...state.tabs, t],
        activeTabId: t.id,
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
    case 'restoreTabs': {
      const activeTabId =
        action.activeTabId && action.tabs.some((t) => t.id === action.activeTabId)
          ? action.activeTabId
          : (action.tabs[0]?.id ?? null);
      return {
        ...state,
        tabs: action.tabs,
        activeTabId,
      };
    }
    case 'setPageContext':
      return { ...state, pageContext: action.pageContext };
    case 'setCompanyContext':
      return { ...state, companyContext: action.companyContext };
    case 'addMention':
      return {
        ...state,
        tabs: state.tabs.map((t) => {
          if (t.id !== action.tabId) return t;
          if (
            t.mentions.some(
              (m) =>
                m.id === action.mention.id && m.kind === action.mention.kind,
            )
          ) {
            return t;
          }
          // Suppress a mention that points to the auto-attached
          // page the user is already viewing — pageContext already
          // covers that grounding and the picker excludes the id,
          // but a stale token could still race in.
          const pc = state.pageContext;
          if (
            pc &&
            action.mention.kind === 'article' &&
            pc.kind === 'article' &&
            pc.articleId === action.mention.id
          ) {
            return t;
          }
          if (
            pc &&
            action.mention.kind === 'asset' &&
            pc.kind === 'asset' &&
            pc.assetId === action.mention.id
          ) {
            return t;
          }
          if (
            pc &&
            action.mention.kind === 'domain' &&
            pc.kind === 'domain' &&
            pc.domainId === action.mention.id
          ) {
            return t;
          }
          return { ...t, mentions: [...t.mentions, action.mention] };
        }),
      };
    case 'removeMention':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId
            ? {
                ...t,
                mentions: t.mentions.filter((m) => m.id !== action.mentionId),
              }
            : t,
        ),
      };
    case 'setMessageToolCalls':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === action.messageId
                    ? { ...m, toolCalls: action.toolCalls }
                    : m,
                ),
              }
            : t,
        ),
      };
    case 'patchToolCall':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id === action.tabId
            ? {
                ...t,
                messages: t.messages.map((m) => {
                  if (m.id !== action.messageId) return m;
                  const calls = m.toolCalls ?? [];
                  return {
                    ...m,
                    toolCalls: calls.map((c) =>
                      c.id === action.toolCallId ? action.next : c,
                    ),
                  };
                }),
              }
            : t,
        ),
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
  sendMessage: (
    tabId: string,
    text: string,
    intent?: ChatTurnIntent,
  ) => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  activeTab: ChatTab | null;
  /**
   * Register a page-context snapshot. Called by `useChatPageContext`
   * from any page that wants the AI to know what the user is looking
   * at. If a matching context tab already exists it is reused; the
   * snapshot's `getMarkdown` closure is refreshed each render.
   * Returns a cleanup that clears the snapshot on the active tab when
   * the page unmounts.
   */
  registerPageContext: (ctx: ChatPageContextSnapshot) => () => void;
  /**
   * Broadcast the active company id for the chat panel. Called once
   * per mount by `CompanyChatContext` from inside the company shell.
   * Unlike `registerPageContext` this only carries `companyId` — it
   * does not imply any article / page snapshot — but it's enough
   * for the @-mention picker to query the right tenant from
   * non-article surfaces (asset detail, layout listing, home).
   * Returns a cleanup that clears the company scope.
   */
  registerCompanyContext: (companyId: string) => () => void;
  /**
   * Live channel for whether the active page has unsaved local edits.
   * Read by the Apply path so we can warn before clobbering an
   * in-progress draft. Written by `useChatPageContext` for any caller
   * that opts into the form-aware dirty contract.
   */
  setPageDirty: (dirty: boolean) => void;
  getPageDirty: () => boolean;
  addMention: (tabId: string, mention: ChatTabContextMention) => void;
  removeMention: (tabId: string, mentionId: string) => void;
  /**
   * Apply a pending tool call. `createOverrides` is forwarded for
   * `create_article` proposals when the user confirmed the target via
   * the Save-as-article dialog. Returns the user-facing error string
   * on failure, or `null` on success.
   */
  applyToolCall: (
    tabId: string,
    messageId: string,
    toolCallId: string,
    options?: {
      createOverrides?: {
        title: string;
        folderId: string | null;
        visibleToClients: boolean;
      };
      companyId?: string;
    },
  ) => Promise<string | null>;
  rejectToolCall: (
    tabId: string,
    messageId: string,
    toolCallId: string,
  ) => Promise<void>;
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
        pageContext: null,
        companyContext: null,
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
      registerPageContext: () => () => {},
      registerCompanyContext: () => () => {},
      setPageDirty: noop,
      getPageDirty: () => false,
      addMention: noop,
      removeMention: noop,
      applyToolCall: async () => null,
      rejectToolCall: asyncNoop,
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
    pageContext: null,
    companyContext: null,
  }));

  // Active stream aborts per tab. Closing a tab or sending a new
  // message before the previous one settled cancels the in-flight
  // fetch so the server can stop talking to the LLM.
  const aborts = useRef(new Map<string, AbortController>());

  // Whether the active page (set via `useChatPageContext`) has
  // unsaved edits. Read by the Apply path so the chat can warn
  // before overwriting a draft.
  const pageDirtyRef = useRef(false);
  const setPageDirty = useCallback((dirty: boolean) => {
    pageDirtyRef.current = dirty;
  }, []);
  const getPageDirty = useCallback(() => pageDirtyRef.current, []);

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
      if (o === '1') dispatch({ type: 'restoreOpen' });
    } catch {
      // localStorage may be unavailable (private mode / SSR). Safe to ignore.
    }
  }, []);

  // Rehydrate the tab strip from localStorage. We only persisted the
  // minimal metadata (id, conversationId, title, icon, mentions, kind
  // + activeTabId); the message history is refetched per-tab from
  // `/chat/conversations/:id` so a tab whose conversation was deleted
  // server-side falls out cleanly. Draft tabs (no `conversationId`
  // yet) round-trip as empty New chats.
  useEffect(() => {
    const persisted = readPersistedTabs();
    if (!persisted || persisted.tabs.length === 0) return;
    let cancelled = false;
    void (async () => {
      const restored = await Promise.all(
        persisted.tabs.map(async (pt): Promise<ChatTab | null> => {
          if (!pt.conversationId) {
            return {
              id: pt.id,
              conversationId: null,
              kind: pt.kind,
              title: pt.title,
              icon: pt.icon,
              messages: [],
              loading: false,
              streamingMessageId: null,
              mentions: pt.mentions,
            };
          }
          const detail = await getChatConversation(pt.conversationId);
          if (!detail) return null;
          return {
            id: pt.id,
            conversationId: detail.id,
            kind: pt.kind,
            title: detail.title || pt.title,
            icon: pt.icon,
            messages: detail.messages.map((m) => ({
              id: m.id,
              role: m.role,
              text: m.content,
              ...(m.toolCalls && m.toolCalls.length > 0
                ? { toolCalls: m.toolCalls }
                : {}),
            })),
            loading: false,
            streamingMessageId: null,
            mentions: pt.mentions,
          };
        }),
      );
      if (cancelled) return;
      const tabs = restored.filter((t): t is ChatTab => t !== null);
      if (tabs.length === 0) return;
      dispatch({
        type: 'restoreTabs',
        tabs,
        activeTabId: persisted.activeTabId,
      });
    })();
    return () => {
      cancelled = true;
    };
    // Mount only — subsequent state changes are persisted via the
    // sibling effect below, never re-fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist tab metadata whenever the tab list / active tab / per-tab
  // title or mentions change. Cheap (one `JSON.stringify` of a tiny
  // payload) so we don't bother debouncing. We intentionally key on
  // the tabs + active id rather than the whole `state` so transient
  // fields (streaming caret, in-flight messages, pageContext) don't
  // schedule writes on every keystroke or stream chunk.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        TABS_KEY,
        JSON.stringify(serializeTabs(state)),
      );
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tabs, state.activeTabId]);

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

  const sendMessage = useCallback(async (
    tabId: string,
    text: string,
    intent?: ChatTurnIntent,
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const tab = stateRef.current.tabs.find((t) => t.id === tabId);
    if (!tab || tab.streamingMessageId) return;

    // Resolve page-context + @-mentions to a `ChatRequestContext`
    // BEFORE we kick off the stream. We do this here (rather than
    // inside `streamChatMessage`) so the provider owns the cross-cut
    // between "what the user is viewing" and "what the LLM sees". A
    // mention that fails to resolve is silently dropped so a single
    // dead reference can't sink the whole send.
    let requestContext: ChatRequestContext | undefined;
    try {
      requestContext = await resolveChatRequestContext(
        tab,
        stateRef.current.pageContext,
        stateRef.current.companyContext,
      );
    } catch {
      requestContext = undefined;
    }

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
        onToolCalls: (messageId, toolCalls) => {
          dispatch({
            type: 'setMessageToolCalls',
            tabId,
            messageId,
            toolCalls,
          });
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
        onNotice: (message) => {
          // Non-fatal (e.g. context trimmed to fit the model). The stream
          // continues; surface for diagnostics without disrupting the
          // reply. A visible inline banner can be layered on later.
          if (typeof console !== 'undefined') console.debug(`[chat] ${message}`);
        },
      },
      ctrl.signal,
      requestContext,
      intent,
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
        ...(m.toolCalls && m.toolCalls.length > 0
          ? { toolCalls: m.toolCalls }
          : {}),
      })),
      loading: false,
      streamingMessageId: null,
      mentions: [],
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

  /**
   * Register a page-context snapshot for the lifetime of the calling
   * component. This is provider-wide state — it does NOT create or
   * activate a tab. Tabs are only opened by explicit user action
   * (the "+ new chat" button or opening a saved conversation), so
   * background navigation never adds noise to the tab strip.
   *
   * The latest snapshot is sampled at send + apply time, so whatever
   * page the user is on when they click Send is what the LLM grounds
   * against — regardless of which tab is active.
   */
  const registerPageContext = useCallback(
    (ctx: ChatPageContextSnapshot): (() => void) => {
      dispatch({ type: 'setPageContext', pageContext: ctx });
      return () => {
        dispatch({ type: 'setPageContext', pageContext: null });
      };
    },
    [],
  );

  const registerCompanyContext = useCallback(
    (companyId: string): (() => void) => {
      dispatch({ type: 'setCompanyContext', companyContext: { companyId } });
      return () => {
        dispatch({ type: 'setCompanyContext', companyContext: null });
      };
    },
    [],
  );

  const addMention = useCallback(
    (tabId: string, mention: ChatTabContextMention) => {
      dispatch({ type: 'addMention', tabId, mention });
    },
    [],
  );

  const removeMention = useCallback(
    (tabId: string, mentionId: string) => {
      dispatch({ type: 'removeMention', tabId, mentionId });
    },
    [],
  );

  const applyToolCall = useCallback(
    async (
      tabId: string,
      messageId: string,
      toolCallId: string,
      options?: {
        createOverrides?: {
          title: string;
          folderId: string | null;
          visibleToClients: boolean;
        };
        companyId?: string;
      },
    ): Promise<string | null> => {
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab || !tab.conversationId) {
        return 'Conversation not initialised yet.';
      }
      // Same precedence as the picker / resolver: prefer the article
      // page snapshot when it's present (its companyId is the one the
      // user is actively editing in) and otherwise fall back to the
      // company shell broadcast so `create_article` works from any
      // company-scoped page (home, asset detail, layouts, etc.). The
      // dialog can also force a specific company via `options.companyId`
      // when the user picked one explicitly.
      const companyId =
        options?.companyId ??
        stateRef.current.pageContext?.companyId ??
        stateRef.current.companyContext?.companyId;
      const result = await applyChatToolCall({
        conversationId: tab.conversationId,
        messageId,
        toolCallId,
        ...(companyId ? { companyId } : {}),
        ...(options?.createOverrides
          ? { createOverrides: options.createOverrides }
          : {}),
      });
      if (!result.ok) return result.error;
      dispatch({
        type: 'patchToolCall',
        tabId,
        messageId,
        toolCallId,
        next: result.data.toolCall,
      });
      // If the apply succeeded but the server marked the call as
      // `failed` (e.g. permissions), surface that to the caller so the
      // dialog can show the message instead of silently closing.
      if (result.data.toolCall.status === 'failed') {
        return result.data.toolCall.error ?? 'Apply failed.';
      }
      return null;
    },
    [],
  );

  const rejectToolCall = useCallback(
    async (tabId: string, messageId: string, toolCallId: string) => {
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab || !tab.conversationId) return;
      const res = await rejectChatToolCall({
        conversationId: tab.conversationId,
        messageId,
        toolCallId,
      });
      if (!res) return;
      dispatch({
        type: 'patchToolCall',
        tabId,
        messageId,
        toolCallId,
        next: res.toolCall,
      });
    },
    [],
  );

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
      registerPageContext,
      registerCompanyContext,
      setPageDirty,
      getPageDirty,
      addMention,
      removeMention,
      applyToolCall,
      rejectToolCall,
    };
  }, [
    state,
    sendMessage,
    openConversation,
    deleteConversation,
    registerPageContext,
    registerCompanyContext,
    setPageDirty,
    getPageDirty,
    addMention,
    removeMention,
    applyToolCall,
    rejectToolCall,
  ]);

  return (
    <ChatPanelContext.Provider value={value}>
      {children}
    </ChatPanelContext.Provider>
  );
}

/**
 * Resolve the per-tab pinned context into the request body shape the
 * API expects. The current page is always included first (so the
 * model can disambiguate "this article" vs. the @-mentions), then
 * each mention. Mentions are fetched + converted lazily; failures are
 * swallowed so a stale or restricted reference doesn't block the send.
 */
async function resolveChatRequestContext(
  tab: ChatTab,
  pageCtx: ChatPageContextSnapshot | null,
  companyCtx: { companyId: string } | null,
): Promise<ChatRequestContext | undefined> {
  const articles: NonNullable<ChatRequestContext['articles']> = [];
  const assets: NonNullable<ChatRequestContext['assets']> = [];
  const domains: NonNullable<ChatRequestContext['domains']> = [];
  const tickets: NonNullable<ChatRequestContext['tickets']> = [];

  // The picker is enabled wherever we have a companyId — either the
  // article page's richer snapshot or the company shell's broadcast.
  // Prefer the article snapshot when both are set so the existing
  // tool-call scoping behavior is preserved.
  const companyId =
    pageCtx?.companyId ?? companyCtx?.companyId ?? null;

  // Only saved articles get inlined as context. Drafts (new-article
  // page) intentionally do NOT travel along — we require the user to
  // save first so the LLM is always grounded in a real row that
  // `update_article` can target. companyId is still attached below
  // so `create_article` works from the new-article page.
  if (pageCtx && pageCtx.kind === 'article' && pageCtx.articleId) {
    const markdown = safeGetMarkdown(pageCtx);
    if (markdown) {
      articles.push({
        id: pageCtx.articleId,
        title: pageCtx.title || 'Untitled',
        markdown,
      });
    }
  }
  // Auto-attach the current asset (when viewing an asset detail page)
  // so the LLM has the same grounding as on article pages without the
  // user having to manually @-mention it. Marked as read-only context
  // server-side; never proposed as a tool-call target.
  if (pageCtx && pageCtx.kind === 'asset') {
    const markdown = safeGetMarkdown(pageCtx);
    if (markdown) {
      assets.push({
        id: pageCtx.assetId,
        name: pageCtx.title,
        layoutName: pageCtx.layoutName,
        markdown,
      });
    }
  }
  // Auto-attach the current domain (when viewing a domain detail page)
  // for the same reason as assets — read-only context, never a tool-
  // call target.
  if (pageCtx && pageCtx.kind === 'domain') {
    const markdown = safeGetMarkdown(pageCtx);
    if (markdown) {
      domains.push({
        id: pageCtx.domainId,
        hostname: pageCtx.title,
        markdown,
      });
    }
  }
  // Auto-attach the current ticket (when viewing a ticket detail
  // page). Tickets are read-only context — they come from an external
  // ticketing system and we don't propose write tool calls against
  // them. They DO travel as their own markdown block so the LLM can
  // ground a `create_article` proposal in the real customer thread.
  if (pageCtx && pageCtx.kind === 'ticket') {
    const markdown = safeGetMarkdown(pageCtx);
    if (markdown) {
      tickets.push({
        id: pageCtx.ticketId,
        provider: pageCtx.provider,
        subject: pageCtx.title,
        markdown,
      });
    }
  }
  if (companyId) {
    // Resolve mentions in parallel — articles, assets, and domains
    // each hit their own endpoint, so a slow article fetch shouldn't
    // gate the others. Order is preserved per kind by zipping the
    // results back against the original mention list.
    const articleMentions = tab.mentions.filter((m) => m.kind === 'article');
    const assetMentions = tab.mentions.filter((m) => m.kind === 'asset');
    const domainMentions = tab.mentions.filter((m) => m.kind === 'domain');
    const [articleResults, assetResults, domainResults] = await Promise.all([
      Promise.all(
        articleMentions.map((m) =>
          fetchArticleAsMarkdown(companyId, m.id),
        ),
      ),
      Promise.all(
        assetMentions.map((m) => fetchAssetAsMarkdown(companyId, m.id)),
      ),
      Promise.all(
        domainMentions.map((m) => fetchDomainAsMarkdown(companyId, m.id)),
      ),
    ]);
    for (const a of articleResults) if (a) articles.push(a);
    for (const a of assetResults) if (a) assets.push(a);
    for (const d of domainResults) if (d) domains.push(d);
  }

  // Dedupe: if the user also @-mentioned the auto-attached asset /
  // domain somehow (e.g. via persisted token), keep only the first
  // instance — the auto-attached entry was pushed first so it wins.
  const seenAssetIds = new Set<string>();
  const dedupedAssets = assets.filter((a) => {
    if (seenAssetIds.has(a.id)) return false;
    seenAssetIds.add(a.id);
    return true;
  });
  const seenDomainIds = new Set<string>();
  const dedupedDomains = domains.filter((d) => {
    if (seenDomainIds.has(d.id)) return false;
    seenDomainIds.add(d.id);
    return true;
  });

  const out: ChatRequestContext = {};
  if (companyId) out.companyId = companyId;
  if (pageCtx?.kind === 'article' && pageCtx.articleId) {
    out.currentArticleId = pageCtx.articleId;
  }
  if (pageCtx?.kind === 'asset') {
    out.currentAssetId = pageCtx.assetId;
  }
  if (pageCtx?.kind === 'domain') {
    out.currentDomainId = pageCtx.domainId;
  }
  if (pageCtx?.kind === 'ticket') {
    out.currentTicketId = pageCtx.ticketId;
  }
  if (articles.length > 0) out.articles = articles;
  if (dedupedAssets.length > 0) out.assets = dedupedAssets;
  if (dedupedDomains.length > 0) out.domains = dedupedDomains;
  if (tickets.length > 0) out.tickets = tickets;
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

function safeGetMarkdown(ctx: ChatPageContextSnapshot): string {
  try {
    return ctx.getMarkdown();
  } catch {
    return '';
  }
}

/**
 * Fetch a referenced article and project it to markdown the LLM can
 * consume. Tiptap docs are converted via the existing client-side
 * helper (we don't want a server-side Tiptap engine in v1). Returns
 * `null` on any failure so callers can skip the mention silently.
 */
async function fetchArticleAsMarkdown(
  companyId: string,
  articleId: string,
): Promise<{ id: string; title: string; markdown: string } | null> {
  const res = await apiFetch<ArticleDetail>(
    `/companies/${companyId}/articles/${articleId}`,
  );
  if (!res.ok || !res.data) return null;
  const a = res.data;
  let markdown = '';
  try {
    if (a.editorMode === 'markdown') {
      markdown = a.markdownSource ?? '';
    } else if (a.content) {
      markdown = tiptapDocToMarkdown(a.content);
    }
  } catch {
    markdown = a.contentPlaintext ?? '';
  }
  if (!markdown.trim()) return null;
  return { id: a.id, title: a.title, markdown };
}

/**
 * Fetch an attached asset and project it to markdown for the chat
 * system prompt. The server already strips fields the requester
 * isn't allowed to see (role-based), so client portal users get a
 * naturally filtered payload — no extra masking needed here.
 * Returns `null` on any fetch failure or empty body so a stale /
 * out-of-scope reference doesn't block the send.
 */
async function fetchAssetAsMarkdown(
  companyId: string,
  assetId: string,
): Promise<
  { id: string; name: string; layoutName: string; markdown: string } | null
> {
  const res = await apiFetch<AssetSummary>(
    `/companies/${companyId}/assets/${assetId}`,
  );
  if (!res.ok || !res.data) return null;
  const asset = res.data;
  const { markdown, layoutName } = assetToMarkdown(asset);
  if (!markdown.trim()) return null;
  return { id: asset.id, name: asset.name, layoutName, markdown };
}

/**
 * Fetch a referenced domain (+ its single most recent check) and
 * project both to markdown for the chat system prompt. The
 * `DomainsService.getById` / `listChecks` endpoints already enforce
 * `domain.read` and filter non-`visibleToClients` rows for client
 * users, so the response naturally mirrors the requester's
 * permissions. Returns `null` on any fetch failure / empty payload
 * so a stale or out-of-scope reference doesn't block the send.
 */
async function fetchDomainAsMarkdown(
  companyId: string,
  domainId: string,
): Promise<{ id: string; hostname: string; markdown: string } | null> {
  const [domainRes, checksRes] = await Promise.all([
    apiFetch<MonitoredDomain>(`/companies/${companyId}/domains/${domainId}`),
    apiFetch<DomainCheck[]>(
      `/companies/${companyId}/domains/${domainId}/checks?limit=1`,
    ),
  ]);
  if (!domainRes.ok || !domainRes.data) return null;
  const latest =
    checksRes.ok && Array.isArray(checksRes.data) && checksRes.data.length > 0
      ? checksRes.data[0] ?? null
      : null;
  const { markdown, hostname } = domainToMarkdown(domainRes.data, latest);
  if (!markdown.trim()) return null;
  return { id: domainRes.data.id, hostname, markdown };
}
