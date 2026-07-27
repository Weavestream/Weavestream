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
  messages: AskMessage[];
}

export const initialAskState: AskState = {
  conversationId: null,
  draft: '',
  status: 'idle',
  toolActivity: null,
  sendError: null,
  metaReceived: false,
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
    }
  | { type: 'conversationCreated'; conversationId: string }
  | { type: 'requestStarted' }
  | { type: 'meta'; conversationId: string }
  | { type: 'delta'; text: string }
  | { type: 'notice'; message: string }
  | { type: 'toolActivity'; label: string | null }
  | { type: 'toolCalls'; toolCalls: ChatToolCallDto[] }
  | { type: 'done' }
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
          },
          {
            clientId: action.assistantClientId,
            role: 'assistant',
            text: '',
            state: 'streaming',
            notices: [],
            toolCalls: [],
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
      return {
        ...state,
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

    case 'reset':
      return initialAskState;
  }
}
