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
import type { ChatConversationDetail } from '@weavestream/shared';
import { randomClientId, streamChatMessage } from '@weavestream/shared/browser';
import { ApiError, apiFetch } from '../../lib/api';
import { redirectToLogin } from '../../lib/navigate';
import { useOrgScope } from '../../lib/org-scope';
import {
  askReducer,
  initialAskState,
  type AskState,
} from './ask-reducer';
import { toolActivityLabel } from './tool-labels';

/**
 * Ask anything's owner. Lives ABOVE the `?sheet=ask` overlay in the
 * shell so the transcript survives close/reopen within the session —
 * a technician who closed the panel to check something finds the
 * finished answer waiting. Memory-only by design: the transcript can
 * quote sensitive documentation and is never persisted.
 *
 * ## Abort discipline (the stale-handler race)
 *
 * Every deliberate abort — Stop, New chat, org switch, unmount —
 * dispatches its state transition SYNCHRONOUSLY, then aborts. An
 * AbortError caught anywhere in the send pipeline dispatches NOTHING.
 * Without that ordering, a `creating` send aborted by an org switch
 * would resolve its catch after the reset and restore the previous
 * org's draft into the new org's panel.
 *
 * ## Controller identity (the done-tail race)
 *
 * `done` is not the end of the SSE response — the server may spend up
 * to ~15s generating the `title` frame before closing. Mobile ignores
 * titles, so `onDone` aborts ITS OWN controller to stop consuming the
 * tail; the composer unlocks immediately and an instant resend runs on
 * a fresh controller. Controllers live in a Set registry; removal sits
 * in the per-send `finally` so it runs on every exit path.
 */

interface AskContextValue {
  state: AskState;
  setDraft: (draft: string) => void;
  /** Sends the current draft. No-op while a send is active or draft empty. */
  send: () => void;
  stop: () => void;
  newChat: () => void;
}

const AskContext = createContext<AskContextValue | null>(null);

export function useAsk(): AskContextValue {
  const value = useContext(AskContext);
  if (!value) throw new Error('useAsk must be used inside AskProvider');
  return value;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function AskProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(askReducer, initialAskState);
  const { currentOrg } = useOrgScope();

  const stateRef = useRef(state);
  stateRef.current = state;
  const orgIdRef = useRef<string | null>(currentOrg?.id ?? null);
  orgIdRef.current = currentOrg?.id ?? null;

  const controllersRef = useRef(new Set<AbortController>());
  const abortAll = useCallback(() => {
    for (const controller of controllersRef.current) controller.abort();
  }, []);

  const setDraft = useCallback(
    (draft: string) => dispatch({ type: 'setDraft', draft }),
    [],
  );

  const send = useCallback(() => {
    const snapshot = stateRef.current;
    const content = snapshot.draft.trim();
    if (!content || snapshot.status !== 'idle') return;

    const controller = new AbortController();
    controllersRef.current.add(controller);
    dispatch({
      type: 'sendStarted',
      userClientId: randomClientId(),
      assistantClientId: randomClientId(),
      content,
      creating: snapshot.conversationId === null,
    });

    void (async () => {
      try {
        let conversationId = snapshot.conversationId;
        if (conversationId === null) {
          try {
            const detail = await apiFetch<ChatConversationDetail>(
              '/chat/conversations',
              { method: 'POST', signal: controller.signal },
            );
            conversationId = detail.id;
          } catch (err) {
            // Abort discipline: the aborting action already dispatched.
            if (isAbortError(err)) return;
            if (err instanceof ApiError && err.status === 401) {
              redirectToLogin();
              return;
            }
            dispatch({
              type: 'createFailed',
              message:
                'Couldn’t start the conversation. Check your connection and try again.',
            });
            return;
          }
          // The await may resolve AFTER a reset already aborted this
          // send — dispatching then would resurrect pre-reset state.
          if (controller.signal.aborted) return;
          dispatch({ type: 'conversationCreated', conversationId });
        }

        const companyId = orgIdRef.current;
        await streamChatMessage(
          conversationId,
          content,
          {
            // The persistence boundary's leading edge: before this, a
            // Stop or CSRF failure provably sent nothing (preflight →
            // rollback); after it, the turn may be persisted.
            onRequestStarted: () => dispatch({ type: 'requestStarted' }),
            onMeta: (meta) =>
              dispatch({ type: 'meta', conversationId: meta.conversationId }),
            onDelta: (text) => dispatch({ type: 'delta', text }),
            onNotice: (message) => dispatch({ type: 'notice', message }),
            onToolActivity: (activity) =>
              dispatch({
                type: 'toolActivity',
                label:
                  activity.status === 'started'
                    ? toolActivityLabel(activity.name)
                    : null,
              }),
            onToolCalls: (_messageId, toolCalls) =>
              dispatch({ type: 'toolCalls', toolCalls }),
            onDone: () => {
              dispatch({ type: 'done' });
              // Mobile ignores the title tail; tear this send down now.
              controller.abort();
            },
            onError: (message, origin) =>
              dispatch({
                type: 'streamFailed',
                message,
                provenance: origin ?? 'transport',
              }),
            onHttpError: (status, message) => {
              // Replaces onError for HTTP-level failures — EVERY status
              // must settle terminally or the composer sticks.
              if (status === 401) {
                redirectToLogin();
                return;
              }
              dispatch({ type: 'streamFailed', message, provenance: 'http' });
            },
          },
          controller.signal,
          companyId ? { companyId } : undefined,
        );
      } finally {
        controllersRef.current.delete(controller);
      }
    })();
  }, []);

  const stop = useCallback(() => {
    dispatch({ type: 'stop' });
    abortAll();
  }, [abortAll]);

  const newChat = useCallback(() => {
    dispatch({ type: 'reset' });
    abortAll();
  }, [abortAll]);

  // Org switch clears the transcript — scope-confusion safety, matching
  // search's current-org-only rationale. Only a real switch (id → other
  // id, or id → none) resets; the initial null → id resolution is not a
  // switch. Reset BEFORE abort, per the discipline above.
  const prevOrgIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = currentOrg?.id ?? null;
    const prev = prevOrgIdRef.current;
    if (prev !== undefined && prev !== null && prev !== id) {
      dispatch({ type: 'reset' });
      abortAll();
    }
    prevOrgIdRef.current = id;
  }, [currentOrg?.id, abortAll]);

  // Unmount (sign-out, redirect-to-login): tear down every stream. No
  // dispatch — the tree is going away.
  useEffect(() => abortAll, [abortAll]);

  const value = useMemo(
    () => ({ state, setDraft, send, stop, newChat }),
    [state, setDraft, send, stop, newChat],
  );

  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}
