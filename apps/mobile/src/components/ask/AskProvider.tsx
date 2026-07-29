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
import { useQueryClient } from '@tanstack/react-query';
import type { ChatConversationDetail, ChatToolCallDto } from '@weavestream/shared';
import { randomClientId, streamChatMessage } from '@weavestream/shared/browser';
import { ApiError, apiFetch } from '../../lib/api';
import { redirectToLogin } from '../../lib/navigate';
import { useOrgScope } from '../../lib/org-scope';
import {
  askReducer,
  initialAskState,
  type AskState,
} from './ask-reducer';
import {
  applyChatToolCall,
  fetchConversation,
  problemMessage,
  rejectChatToolCall,
  type CreateOverrides,
} from './chat-actions';
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
  /**
   * Apply a pending proposal (Phase 5b). Globally single-flight: a
   * no-op while any tool action is in flight. Lives on the provider —
   * not the overlay — so a settle landing after the user closes Ask
   * still reaches state. `opts.companyId` is sent ONLY by the create
   * confirmation sheet.
   */
  applyToolCall: (
    serverMessageId: string,
    toolCallId: string,
    opts?: { companyId: string; createOverrides: CreateOverrides },
  ) => Promise<void>;
  /** Reject a pending proposal. Same single-flight rule. */
  rejectToolCall: (serverMessageId: string, toolCallId: string) => Promise<void>;
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
  const queryClient = useQueryClient();

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

  /**
   * Post-meta transport recovery (Phase 5b): re-read the conversation
   * and replace the failed bubble with the persisted truth. ONE
   * delayed retry (~2.5 s) covers the server still being mid-commit
   * after the disconnect abort; still absent after that, the retained
   * error state stands (honest). Abort-safe: registered in the
   * controller set, so reset/unmount cancels it and an AbortError
   * dispatches nothing.
   */
  const recoverTurn = useCallback(
    async (conversationId: string, serverMessageId: string) => {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 2500);
              controller.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('recovery aborted', 'AbortError'));
              });
            });
          }
          const detail = await fetchConversation(conversationId, controller.signal);
          const msg = detail.messages.find((m) => m.id === serverMessageId);
          if (msg) {
            dispatch({
              type: 'turnRecovered',
              serverMessageId,
              text: msg.content,
              toolCalls: msg.toolCalls ?? [],
            });
            return;
          }
        }
      } catch {
        // Recovery is best-effort on top of an already-surfaced error;
        // the retained error state remains the honest answer.
      } finally {
        controllersRef.current.delete(controller);
      }
    },
    [],
  );

  const send = useCallback(() => {
    const snapshot = stateRef.current;
    const content = snapshot.draft.trim();
    if (!content || snapshot.status !== 'idle') return;

    const controller = new AbortController();
    controllersRef.current.add(controller);
    // Captured ONCE per turn: the recorded scope must be exactly the
    // context this send transmits (the create sheet's org-lock rule
    // reads it back), and the org-switch reset aborts in-flight sends
    // anyway, so a late re-read could only ever disagree.
    const scopeCompanyId = orgIdRef.current;
    dispatch({
      type: 'sendStarted',
      userClientId: randomClientId(),
      assistantClientId: randomClientId(),
      content,
      creating: snapshot.conversationId === null,
      scopeCompanyId,
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

        // Post-meta transport recovery bookkeeping (Phase 5b): the
        // server persists the assistant row BEFORE emitting tool_call,
        // so a connection dropped in that gap leaves us holding the id
        // with no cards — re-readable truth.
        let assistantMessageId: string | null = null;
        const streamConversationId = conversationId;
        await streamChatMessage(
          conversationId,
          content,
          {
            // The persistence boundary's leading edge: before this, a
            // Stop or CSRF failure provably sent nothing (preflight →
            // rollback); after it, the turn may be persisted.
            onRequestStarted: () => dispatch({ type: 'requestStarted' }),
            onMeta: (meta) => {
              assistantMessageId = meta.assistantMessageId;
              dispatch({
                type: 'meta',
                conversationId: meta.conversationId,
                assistantMessageId: meta.assistantMessageId,
              });
            },
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
            onToolCalls: (messageId, toolCalls) =>
              dispatch({ type: 'toolCalls', messageId, toolCalls }),
            onDone: () => {
              dispatch({ type: 'done' });
              // Mobile ignores the title tail; tear this send down now.
              controller.abort();
            },
            onError: (message, origin) => {
              const provenance = origin ?? 'transport';
              dispatch({ type: 'streamFailed', message, provenance });
              // Transport death AFTER meta = the turn is (or is about
              // to be) persisted with content this client never fully
              // received. Recover the persisted truth so proposal
              // cards aren't silently lost (plan-review P1-5).
              if (provenance === 'transport' && assistantMessageId) {
                void recoverTurn(streamConversationId, assistantMessageId);
              }
            },
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
          scopeCompanyId ? { companyId: scopeCompanyId } : undefined,
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

  /**
   * An APPLIED proposal mutated an article server-side, so every cached
   * article read is stale. Ask is an overlay ABOVE the mounted tab
   * screen, so nothing remounts to refetch on its own — without this a
   * created article only appeared after navigating away from Articles
   * and back, and a patched body kept rendering its pre-apply text.
   *
   * The whole `['articles']` / `['search']` prefixes, not one company's:
   * a global turn creates in an org that need not be the current scope,
   * and an edit proposal's target company comes from the proposal
   * (`targetCompanyId`), not the shell. Refetching also re-bases any
   * SIBLING pending edit card against the new revision, so the shared
   * ladder reports "the article changed" before Apply instead of the
   * server rejecting it after.
   *
   * Keyed on the SETTLED STATUS, not on the action: a reject settles
   * nothing — except reject-recovery, which reports `applied` because a
   * crashed apply's article really does exist. One rule covers both.
   */
  const invalidateArticleReads = useCallback(
    (toolCalls: readonly ChatToolCallDto[], toolCallId: string) => {
      const settled = toolCalls.find((c) => c.id === toolCallId);
      if (settled?.status !== 'applied') return;
      void queryClient.invalidateQueries({ queryKey: ['articles'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
    },
    [queryClient],
  );

  /**
   * Resync a message's tool calls from the persisted conversation —
   * the already-settled 400 race (another device acted first; the
   * claim guarantees exactly one winner) and the create-recovery code
   * both resolve by reading what actually happened.
   *
   * Reports whether the TARGET call actually settled: a generic 400
   * (e.g. a validation rejection) leaves it pending, and treating that
   * resync as success would swallow the error — the button would
   * appear to do nothing. Only a genuine status change earns silence.
   */
  const resyncToolCalls = useCallback(
    async (
      conversationId: string,
      serverMessageId: string,
      toolCallId: string,
      signal: AbortSignal,
    ): Promise<'settled' | 'pending' | 'missing'> => {
      const detail = await fetchConversation(conversationId, signal);
      const msg = detail.messages.find((m) => m.id === serverMessageId);
      if (!msg?.toolCalls) return 'missing';
      dispatch({
        type: 'toolCallSettled',
        serverMessageId,
        toolCalls: msg.toolCalls,
      });
      // The other device's apply (or our own recovered crash) mutated an
      // article just as surely as a local apply would have.
      invalidateArticleReads(msg.toolCalls, toolCallId);
      const target = msg.toolCalls.find((c) => c.id === toolCallId);
      return target && target.status !== 'pending' ? 'settled' : 'pending';
    },
    [invalidateArticleReads],
  );

  const runToolAction = useCallback(
    async (
      kind: 'apply' | 'reject',
      serverMessageId: string,
      toolCallId: string,
      opts?: { companyId: string; createOverrides: CreateOverrides },
    ) => {
      const snapshot = stateRef.current;
      // Single-flight, enforced HERE (not just disabled buttons): a
      // second invocation while one is active is a no-op, so a late
      // response can never wipe a newer action's indicator.
      if (snapshot.toolAction || !snapshot.conversationId) return;
      const conversationId = snapshot.conversationId;
      dispatch({ type: 'toolActionStarted', toolCallId, kind });

      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        const res =
          kind === 'apply'
            ? await applyChatToolCall(
                {
                  conversationId,
                  messageId: serverMessageId,
                  toolCallId,
                  ...(opts ?? {}),
                },
                controller.signal,
              )
            : await rejectChatToolCall(
                { conversationId, messageId: serverMessageId, toolCallId },
                controller.signal,
              );
        // Server truth, whatever it says — a `failed` status renders as
        // failure; success styling never comes from the request merely
        // resolving.
        dispatch({
          type: 'toolCallSettled',
          serverMessageId,
          toolCalls: res.updatedToolCalls,
        });
        invalidateArticleReads(res.updatedToolCalls, toolCallId);
      } catch (err) {
        if (isAbortError(err)) return;
        if (err instanceof ApiError && err.status === 401) {
          redirectToLogin();
          return;
        }
        if (err instanceof ApiError && err.status === 400) {
          // Two 400s carry more than a message: the already-settled
          // race (resync shows what the other device did) and the
          // create-recovery rejection (resync brings the pendingCreate
          // marker so the sheet locks to the original confirmation).
          // The resync RESULT decides what the user sees: a genuinely
          // settled call earns silence — the card now tells the truth —
          // while a still-pending call (recovery, or any validation
          // 400) falls through to the error line below, so Apply never
          // appears to do nothing.
          const synced = await resyncToolCalls(
            conversationId,
            serverMessageId,
            toolCallId,
            controller.signal,
          ).catch(() => 'missing' as const);
          if (synced === 'settled') return;
        }
        dispatch({
          type: 'toolActionFailed',
          toolCallId,
          message: problemMessage(
            err,
            kind === 'apply' ? 'Couldn’t apply the change.' : 'Couldn’t reject the change.',
          ),
        });
      } finally {
        controllersRef.current.delete(controller);
      }
    },
    [invalidateArticleReads, resyncToolCalls],
  );

  const applyToolCall = useCallback(
    (
      serverMessageId: string,
      toolCallId: string,
      opts?: { companyId: string; createOverrides: CreateOverrides },
    ) => runToolAction('apply', serverMessageId, toolCallId, opts),
    [runToolAction],
  );

  const rejectToolCall = useCallback(
    (serverMessageId: string, toolCallId: string) =>
      runToolAction('reject', serverMessageId, toolCallId),
    [runToolAction],
  );

  // Any change of scope IDENTITY resets the transcript (Phase 5b D2):
  // entering, leaving, or switching orgs — a transcript of global turns
  // must not continue under an org chip, nor the reverse. Only the boot
  // adoption (undefined → first value) is exempt. Cost accepted: an
  // unactioned global proposal card disappears from the MOBILE view on
  // entering an org (the server keeps it pending; cards are actionable
  // in place before switching, so no flow requires the switch). Reset
  // BEFORE abort, per the discipline above.
  const prevOrgIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = currentOrg?.id ?? null;
    const prev = prevOrgIdRef.current;
    if (prev !== undefined && prev !== id) {
      dispatch({ type: 'reset' });
      abortAll();
    }
    prevOrgIdRef.current = id;
  }, [currentOrg?.id, abortAll]);

  // Unmount (sign-out, redirect-to-login): tear down every stream. No
  // dispatch — the tree is going away.
  useEffect(() => abortAll, [abortAll]);

  const value = useMemo(
    () => ({ state, setDraft, send, stop, newChat, applyToolCall, rejectToolCall }),
    [state, setDraft, send, stop, newChat, applyToolCall, rejectToolCall],
  );

  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}
