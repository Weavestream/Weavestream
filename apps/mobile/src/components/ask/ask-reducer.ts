import type { ChatToolCallDto } from '@weavestream/shared';

/**
 * Ask anything's transcript state machine. Pure — the provider owns the
 * side effects (fetches, aborts, redirects) and this owns every
 * transition, so the failure policy is testable without a network.
 *
 * ## The rollback policy (why `provenance` + `metaReceived` exist)
 *
 * The server persists the user turn BEFORE emitting `meta`
 * (chat-stream.service.ts), and deliberately emits every pre-persist
 * failure (not-found / forbidden / AI-disabled) as an `error` frame
 * BEFORE the DB write. So:
 *
 *  - An `error` FRAME before `meta` is provably unpersisted → roll the
 *    optimistic pair back, restore the draft, surface `sendError`.
 *  - A PREFLIGHT failure (CSRF acquisition — the message POST was
 *    never dispatched) provably sent nothing → rollback.
 *  - A TRANSPORT failure (network drop, unexpected EOF) before `meta`
 *    is ambiguous — the commit may have landed and the connection died
 *    in the gap before `meta` — so the turn is RETAINED (user bubble
 *    kept, assistant bubble errored, no draft restore). Resending a
 *    rolled-back-but-persisted turn would duplicate server history.
 *  - An HTTP rejection never reached the SSE controller → rollback.
 *  - After `meta`, everything settles in place.
 *
 * Stop follows the same line: during `creating` and `preflight`
 * nothing was sent, so the pair drops and the draft returns; once the
 * streamer reports the message POST dispatched (`requestStarted` →
 * `streaming`), Stop settles the bubble and never rolls back.
 */

export interface AskMessage {
  /** `randomClientId()` — NEVER `crypto.randomUUID()` (LAN-HTTP dev). */
  clientId: string;
  role: 'user' | 'assistant';
  text: string;
  state: 'done' | 'streaming' | 'error' | 'stopped';
  error?: string;
  notices: string[];
  toolCalls: ChatToolCallDto[];
  /**
   * The persisted message id (assistant rows), stamped from `meta`'s
   * pre-allocated `assistantMessageId` — the earliest frame carrying
   * it, always pairing the optimistic bubble, and the exact `:msgId`
   * the apply/reject endpoints address. Null until `meta` (and always
   * on user rows).
   */
  serverMessageId: string | null;
  /**
   * The `context.companyId` the provider sent for THIS turn (null =
   * a global, org-free turn). Drives the create sheet's org rule: a
   * company-scoped turn's org is locked (the server applies the turn's
   * scope regardless of the body), a global turn requires an explicit
   * choice.
   */
  scopeCompanyId: string | null;
}

/**
 * `creating`  — the conversation POST is in flight (nothing sent).
 * `preflight` — the streamer is acquiring CSRF; the message POST has
 *               NOT been dispatched yet (nothing sent).
 * `streaming` — the message POST is out; the turn may be persisted.
 */
export type AskStatus = 'idle' | 'creating' | 'preflight' | 'streaming';

export interface AskState {
  conversationId: string | null;
  /** Composer text; prefilled by the search handoff card. */
  draft: string;
  status: AskStatus;
  /** Transient "Searching…" line, from `tool_activity` frames. */
  toolActivity: string | null;
  /** Inline line above the composer for rolled-back sends. */
  sendError: string | null;
  /** Whether `meta` arrived for the in-flight turn — persistence proof. */
  metaReceived: boolean;
  /**
   * The ONE proposal action in flight (Phase 5b): apply/reject are
   * globally single-flight — the provider no-ops further invocations
   * and every card disables its buttons while this is set. Lives here
   * (not in the overlay) so closing/reopening Ask can't lose it.
   */
  toolAction: { toolCallId: string; kind: 'apply' | 'reject' } | null;
  /** Transient per-card failure line; the call itself stays pending. */
  toolActionError: { toolCallId: string; message: string } | null;
  messages: AskMessage[];
}

export const initialAskState: AskState = {
  conversationId: null,
  draft: '',
  status: 'idle',
  toolActivity: null,
  sendError: null,
  metaReceived: false,
  toolAction: null,
  toolActionError: null,
  messages: [],
};

export type AskFailureProvenance = 'frame' | 'transport' | 'http' | 'preflight';

export type AskAction =
  | { type: 'setDraft'; draft: string }
  | {
      type: 'sendStarted';
      userClientId: string;
      assistantClientId: string;
      content: string;
      creating: boolean;
      scopeCompanyId: string | null;
    }
  | { type: 'conversationCreated'; conversationId: string }
  | { type: 'requestStarted' }
  | { type: 'meta'; conversationId: string; assistantMessageId: string }
  | { type: 'delta'; text: string }
  | { type: 'notice'; message: string }
  | { type: 'toolActivity'; label: string | null }
  | { type: 'toolCalls'; messageId: string; toolCalls: ChatToolCallDto[] }
  | { type: 'done' }
  | { type: 'toolActionStarted'; toolCallId: string; kind: 'apply' | 'reject' }
  | { type: 'toolActionFailed'; toolCallId: string; message: string }
  | {
      type: 'toolCallSettled';
      serverMessageId: string;
      toolCalls: ChatToolCallDto[];
    }
  | {
      type: 'turnRecovered';
      serverMessageId: string;
      text: string;
      toolCalls: ChatToolCallDto[];
    }
  | { type: 'createFailed'; message: string }
  | { type: 'streamFailed'; message: string; provenance: AskFailureProvenance }
  | { type: 'stop' }
  | { type: 'reset' };

/** The optimistic pair is always the last two messages. */
function rollbackPair(state: AskState, sendError: string | null): AskState {
  const user = state.messages[state.messages.length - 2];
  const assistant = state.messages[state.messages.length - 1];
  const pairPresent = user?.role === 'user' && assistant?.role === 'assistant';
  return {
    ...state,
    messages: pairPresent ? state.messages.slice(0, -2) : state.messages,
    draft: pairPresent ? user.text : state.draft,
    sendError,
    status: 'idle',
    toolActivity: null,
    metaReceived: false,
  };
}

function withLastAssistant(
  state: AskState,
  update: (message: AskMessage) => AskMessage,
): AskState {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return state;
  return {
    ...state,
    messages: [...state.messages.slice(0, -1), update(last)],
  };
}

/** Retain the turn: settle the assistant bubble as errored, in place. */
function retainWithError(state: AskState, message: string): AskState {
  return {
    ...withLastAssistant(state, (m) => ({
      ...m,
      state: 'error',
      error: message,
    })),
    status: 'idle',
    toolActivity: null,
    metaReceived: false,
  };
}

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case 'setDraft':
      return { ...state, draft: action.draft };

    case 'sendStarted':
      return {
        ...state,
        draft: '',
        sendError: null,
        metaReceived: false,
        // Never straight to 'streaming' — the streamer still has CSRF
        // acquisition ahead; `requestStarted` marks the real dispatch.
        status: action.creating ? 'creating' : 'preflight',
        toolActivity: null,
        messages: [
          ...state.messages,
          {
            clientId: action.userClientId,
            role: 'user',
            text: action.content,
            state: 'done',
            notices: [],
            toolCalls: [],
            serverMessageId: null,
            scopeCompanyId: action.scopeCompanyId,
          },
          {
            clientId: action.assistantClientId,
            role: 'assistant',
            text: '',
            state: 'streaming',
            notices: [],
            toolCalls: [],
            serverMessageId: null,
            scopeCompanyId: action.scopeCompanyId,
          },
        ],
      };

    case 'conversationCreated':
      return {
        ...state,
        conversationId: action.conversationId,
        // The message POST hasn't been dispatched yet — that's
        // `requestStarted`'s job.
        status: 'preflight',
      };

    case 'requestStarted':
      return state.status === 'preflight'
        ? { ...state, status: 'streaming' }
        : state;

    case 'meta':
      // `assistantMessageId` is pre-allocated server-side and becomes
      // the persisted row's PK — stamping it here is what makes the
      // proposal cards addressable (apply/reject `:msgId`) and the
      // post-meta transport recovery possible.
      return {
        ...withLastAssistant(state, (m) => ({
          ...m,
          serverMessageId: action.assistantMessageId,
        })),
        conversationId: action.conversationId,
        metaReceived: true,
      };

    case 'delta':
      return withLastAssistant(state, (m) =>
        m.state === 'streaming' ? { ...m, text: m.text + action.text } : m,
      );

    case 'notice':
      return withLastAssistant(state, (m) => ({
        ...m,
        notices: [...m.notices, action.message],
      }));

    case 'toolActivity':
      return { ...state, toolActivity: action.label };

    case 'toolCalls':
      return withLastAssistant(state, (m) => ({
        ...m,
        toolCalls: [...m.toolCalls, ...action.toolCalls],
        // Defensive: `meta` precedes `tool_call` on the same ordered
        // stream, but a lost meta must not leave the cards unaddressable.
        serverMessageId: m.serverMessageId ?? action.messageId,
      }));

    case 'done':
      return {
        ...withLastAssistant(state, (m) =>
          m.state === 'streaming' ? { ...m, state: 'done' } : m,
        ),
        status: 'idle',
        toolActivity: null,
        metaReceived: false,
      };

    case 'createFailed':
      // No message reached the server — provably nothing to duplicate.
      return rollbackPair(state, action.message);

    case 'streamFailed': {
      if (action.provenance === 'http' || action.provenance === 'preflight') {
        // http: pre-controller problem+json — the server never switched
        // to SSE. preflight: the message POST was never dispatched.
        // Either way, nothing was persisted.
        return rollbackPair(state, action.message);
      }
      if (action.provenance === 'frame' && !state.metaReceived) {
        // The server explicitly failed BEFORE its DB write.
        return rollbackPair(state, action.message);
      }
      // Ambiguous (transport) or post-persist (frame after meta):
      // retain the turn.
      return retainWithError(state, action.message);
    }

    case 'stop': {
      if (state.status === 'creating' || state.status === 'preflight') {
        // Nothing was sent yet — a silent rollback, no error line.
        return rollbackPair(state, null);
      }
      if (state.status === 'streaming') {
        return {
          ...withLastAssistant(state, (m) =>
            m.state === 'streaming'
              ? { ...m, state: m.text ? 'done' : 'stopped' }
              : m,
          ),
          status: 'idle',
          toolActivity: null,
          metaReceived: false,
        };
      }
      return state;
    }

    case 'toolActionStarted':
      // Single-flight: the provider guards, the reducer re-guards.
      if (state.toolAction) return state;
      return {
        ...state,
        toolAction: { toolCallId: action.toolCallId, kind: action.kind },
        toolActionError: null,
      };

    case 'toolActionFailed':
      return {
        ...state,
        toolAction:
          state.toolAction?.toolCallId === action.toolCallId ? null : state.toolAction,
        toolActionError: { toolCallId: action.toolCallId, message: action.message },
      };

    case 'toolCallSettled': {
      // Server truth: replace the message's whole array with the
      // returned `updatedToolCalls` — richer than patching one call
      // (sibling statuses and markers ride along) and self-healing.
      const byId = state.messages.some(
        (m) => m.serverMessageId === action.serverMessageId,
      );
      const settledIds = new Set(action.toolCalls.map((c) => c.id));
      return {
        ...state,
        toolAction: null,
        toolActionError: null,
        messages: state.messages.map((m) => {
          const matches = byId
            ? m.serverMessageId === action.serverMessageId
            : // Fallback: the message holding any of the settled calls
              // (a lost meta left `serverMessageId` null).
              m.role === 'assistant' && m.toolCalls.some((c) => settledIds.has(c.id));
          return matches ? { ...m, toolCalls: action.toolCalls } : m;
        }),
      };
    }

    case 'turnRecovered':
      // Post-meta transport recovery: the persisted truth replaces the
      // half-streamed bubble — text, cards, and the error state.
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.serverMessageId !== action.serverMessageId) return m;
          const { error: _dropped, ...rest } = m;
          return {
            ...rest,
            text: action.text,
            toolCalls: action.toolCalls,
            state: 'done',
          };
        }),
      };

    case 'reset':
      return initialAskState;
  }
}
