/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Org } from '../../lib/org-scope';

/**
 * The provider's side-effect discipline, driven through the real
 * reducer with the network mocked:
 *
 *  - per-send controller identity (the done-tail race): after `done`
 *    the first send's controller is aborted and only the second
 *    remains live;
 *  - the abort discipline (the stale-handler race): a `creating` send
 *    aborted by an org switch or New chat must NOT restore the old
 *    draft after the reset;
 *  - 401 routing on both the create POST and the stream;
 *  - article-read invalidation on an APPLIED settle (the stale-list
 *    bug: Ask floats above the mounted tab screen, so nothing
 *    remounts to refetch a created/edited article on its own).
 */

const ORG_A: Org = { id: 'org-a', name: 'Acme', initials: 'AC', subtitle: null };
const ORG_B: Org = { id: 'org-b', name: 'Beta', initials: 'BE', subtitle: null };

let currentOrg: Org | null = ORG_A;
jest.mock('../../lib/org-scope', () => ({
  useOrgScope: () => ({ currentOrg, scopeStatus: 'ready' }),
}));

const redirectToLoginMock = jest.fn();
jest.mock('../../lib/navigate', () => ({
  redirectToLogin: () => redirectToLoginMock(),
}));

const apiFetchMock = jest.fn();
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

interface StreamInvocation {
  conversationId: string;
  content: string;
  handlers: Record<string, (...args: never[]) => void>;
  signal: AbortSignal;
  context: unknown;
  resolve: () => void;
}
const streamInvocations: StreamInvocation[] = [];
jest.mock('@weavestream/shared/browser', () => ({
  randomClientId: () => `id-${counter++}`,
  streamChatMessage: (
    conversationId: string,
    content: string,
    handlers: Record<string, (...args: never[]) => void>,
    signal: AbortSignal,
    context: unknown,
  ) =>
    new Promise<void>((resolve) => {
      streamInvocations.push({
        conversationId,
        content,
        handlers,
        signal,
        context,
        resolve,
      });
      // Like the real streamer: CSRF succeeded, the POST dispatches.
      handlers.onRequestStarted?.();
      // Resolve when aborted, like the real client's silent AbortError path.
      signal.addEventListener('abort', () => resolve());
    }),
}));
let counter = 0;

import { AskProvider, useAsk } from './AskProvider';

function Harness() {
  const { state, setDraft, send, stop, newChat } = useAsk();
  return (
    <div>
      <output data-testid="status">{state.status}</output>
      <output data-testid="draft">{state.draft}</output>
      <output data-testid="count">{state.messages.length}</output>
      <output data-testid="last-text">
        {state.messages[state.messages.length - 1]?.text ?? ''}
      </output>
      <button onClick={() => setDraft('reboot steps?')}>seed</button>
      <button onClick={send}>send</button>
      <button onClick={stop}>stop</button>
      <button onClick={newChat}>new</button>
    </div>
  );
}

/**
 * The provider reaches for the query cache to invalidate article reads
 * after an applied proposal, so every mount needs a real client. A
 * fresh one per test keeps the `invalidateQueries` spy honest.
 */
let queryClient: QueryClient;
let invalidateSpy: jest.SpyInstance;

function withQuery(children: ReactNode) {
  return (
    <QueryClientProvider client={queryClient}>
      <AskProvider>{children}</AskProvider>
    </QueryClientProvider>
  );
}

/** The prefixes passed to `invalidateQueries`, in call order. */
function invalidatedKeys(): unknown[][] {
  return invalidateSpy.mock.calls.map(
    (call) => (call[0] as { queryKey: unknown[] }).queryKey,
  );
}

function mount() {
  return render(withQuery(<Harness />));
}

async function flush() {
  await act(async () => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  streamInvocations.length = 0;
  currentOrg = ORG_A;
  apiFetchMock.mockResolvedValue({ id: 'conv-1' });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
});

async function seedAndSend() {
  screen.getByText('seed').click();
  await flush();
  screen.getByText('send').click();
  await flush();
}

describe('AskProvider', () => {
  it('creates the conversation lazily and streams with the org context', async () => {
    mount();
    await act(seedAndSend);

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/chat/conversations',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(streamInvocations).toHaveLength(1);
    const call = streamInvocations[0]!;
    expect(call.conversationId).toBe('conv-1');
    expect(call.content).toBe('reboot steps?');
    expect(call.context).toEqual({ companyId: ORG_A.id });
    expect(screen.getByTestId('status')).toHaveTextContent('streaming');
    expect(screen.getByTestId('count')).toHaveTextContent('2');
  });

  it('after done, the first send is torn down and an immediate resend runs on a fresh controller', async () => {
    mount();
    await act(seedAndSend);
    const first = streamInvocations[0]!;

    // meta + a delta + done — the server may keep the connection open
    // ~15s for the title tail, but mobile ignores titles.
    act(() => {
      first.handlers.onMeta?.({ conversationId: 'conv-1' } as never);
      first.handlers.onDelta?.('answer one' as never);
      first.handlers.onDone?.(null as never);
    });
    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    // Its own controller was aborted so the tail is not consumed.
    expect(first.signal.aborted).toBe(true);

    // Immediate resend while stream #1's promise settles.
    await act(seedAndSend);
    expect(streamInvocations).toHaveLength(2);
    const second = streamInvocations[1]!;
    expect(second.signal.aborted).toBe(false);
    expect(second.signal).not.toBe(first.signal);
    expect(screen.getByTestId('count')).toHaveTextContent('4');
  });

  it('org switch during creating: reset wins — the old draft never resurfaces', async () => {
    // The create POST hangs until we settle it, like a stalled radio.
    let rejectCreate!: (err: unknown) => void;
    apiFetchMock.mockImplementation(
      (_path: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          rejectCreate = reject;
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const view = mount();
    await act(seedAndSend);
    expect(screen.getByTestId('status')).toHaveTextContent('creating');

    // Org switch: the provider resets FIRST, then aborts — the aborted
    // create's catch must dispatch nothing afterwards.
    currentOrg = ORG_B;
    view.rerender(withQuery(<Harness />));
    await flush();

    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    expect(screen.getByTestId('draft')).toHaveTextContent('');
    void rejectCreate;
  });

  it('New chat during creating clears without restoring the draft', async () => {
    apiFetchMock.mockImplementation(
      (_path: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    mount();
    await act(seedAndSend);

    screen.getByText('new').click();
    await flush();

    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    expect(screen.getByTestId('draft')).toHaveTextContent('');
  });

  it('Stop during creating restores the draft — nothing was sent', async () => {
    apiFetchMock.mockImplementation(
      (_path: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    mount();
    await act(seedAndSend);

    screen.getByText('stop').click();
    await flush();

    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    expect(screen.getByTestId('draft')).toHaveTextContent('reboot steps?');
  });

  it('routes a 401 from the create POST to login', async () => {
    const { ApiError } = jest.requireActual('../../lib/api');
    apiFetchMock.mockRejectedValue(new ApiError(401, null));
    mount();
    await act(seedAndSend);

    expect(redirectToLoginMock).toHaveBeenCalled();
  });

  it('routes a 401 HTTP rejection on the stream to login', async () => {
    const view = mount();
    await act(seedAndSend);
    const first = streamInvocations[0]!;

    // No settling dispatch on 401 — the redirect hard-navigates the
    // whole tree away in the real app.
    act(() => first.handlers.onHttpError?.(401 as never, 'Unauthorized' as never));
    expect(redirectToLoginMock).toHaveBeenCalled();
    view.unmount();
  });

  it('a non-401 HTTP rejection on the stream settles terminally: rollback + draft restored', async () => {
    mount();
    await act(seedAndSend);
    const first = streamInvocations[0]!;

    act(() =>
      first.handlers.onHttpError?.(429 as never, 'Too many requests' as never),
    );
    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    expect(screen.getByTestId('draft')).toHaveTextContent('reboot steps?');
  });
});

// ---------------------------------------------------------------------
// Phase 5b — tool actions, transport recovery, scope matrix
// ---------------------------------------------------------------------

const PENDING_CALL = {
  id: 'tc-1',
  name: 'patch_article',
  arguments: { article_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', edits: [] },
  status: 'pending',
  baseRevision: 3,
} as const;

function ActionsHarness() {
  const { state, setDraft, send, applyToolCall, rejectToolCall } = useAsk();
  const last = state.messages[state.messages.length - 1];
  return (
    <div>
      <output data-testid="status">{state.status}</output>
      <output data-testid="count">{state.messages.length}</output>
      <output data-testid="last-text">{last?.text ?? ''}</output>
      <output data-testid="msg-id">{last?.serverMessageId ?? 'none'}</output>
      <output data-testid="call-status">
        {last?.toolCalls[0]?.status ?? 'none'}
      </output>
      <output data-testid="action">
        {state.toolAction ? `${state.toolAction.kind}:${state.toolAction.toolCallId}` : 'none'}
      </output>
      <output data-testid="action-error">
        {state.toolActionError?.message ?? 'none'}
      </output>
      <button onClick={() => setDraft('draft it')}>seed</button>
      <button onClick={send}>send</button>
      <button onClick={() => void applyToolCall('m1', 'tc-1')}>apply</button>
      <button
        onClick={() =>
          void applyToolCall('m1', 'tc-1', {
            companyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            createOverrides: { title: 'T', folderId: null, visibleToClients: false },
          })
        }
      >
        apply-create
      </button>
      <button onClick={() => void applyToolCall('m1', 'tc-2')}>apply-sibling</button>
      <button onClick={() => void rejectToolCall('m1', 'tc-1')}>reject</button>
    </div>
  );
}

function mountActions() {
  return render(withQuery(<ActionsHarness />));
}

/** Drive one full turn that yields the pending proposal on message m1. */
async function driveTurn() {
  apiFetchMock.mockResolvedValueOnce({ id: 'c1' }); // POST /chat/conversations
  act(() => {
    screen.getByText('seed').click();
  });
  await act(async () => {
    screen.getByText('send').click();
  });
  const stream = streamInvocations[streamInvocations.length - 1]!;
  act(() => {
    (stream.handlers.onMeta as (m: unknown) => void)({
      conversationId: 'c1',
      userMessageId: 'um1',
      assistantMessageId: 'm1',
      title: null,
    });
    (stream.handlers.onToolCalls as (id: string, c: unknown) => void)('m1', [PENDING_CALL]);
    (stream.handlers.onDone as (r: unknown) => void)(null);
  });
}

describe('AskProvider — tool actions (5b)', () => {
  beforeEach(() => {
    currentOrg = ORG_A;
    streamInvocations.length = 0;
    apiFetchMock.mockReset();
    redirectToLoginMock.mockClear();
  });

  it('keeps the SSE messageId and applies through the real endpoint WITHOUT companyId', async () => {
    mountActions();
    await driveTurn();
    expect(screen.getByTestId('msg-id')).toHaveTextContent('m1');

    apiFetchMock.mockResolvedValueOnce({
      toolCall: { ...PENDING_CALL, status: 'applied', result: 'Edited article "X".' },
      updatedToolCalls: [{ ...PENDING_CALL, status: 'applied', result: 'Edited article "X".' }],
    });
    await act(async () => {
      screen.getByText('apply').click();
    });

    const [path, init] = apiFetchMock.mock.calls[apiFetchMock.mock.calls.length - 1]!;
    expect(path).toBe('/chat/conversations/c1/messages/m1/tool-calls/tc-1/apply');
    // Patch/update: the persisted turn context is authoritative — the
    // client must NOT volunteer the current org.
    expect(JSON.parse((init as { body: string }).body)).toEqual({});
    expect(screen.getByTestId('call-status')).toHaveTextContent('applied');
    expect(screen.getByTestId('action')).toHaveTextContent('none');
  });

  // The stale-list bug: Ask is an overlay above the mounted tab screen,
  // so an applied proposal has to evict the article reads itself.
  it('an applied settle invalidates the article and search reads', async () => {
    mountActions();
    await driveTurn();

    apiFetchMock.mockResolvedValueOnce({
      toolCall: { ...PENDING_CALL, status: 'applied', result: 'Created article "T".' },
      updatedToolCalls: [{ ...PENDING_CALL, status: 'applied', result: 'Created article "T".' }],
    });
    await act(async () => {
      screen.getByText('apply-create').click();
    });

    // Whole prefixes, not one company's: a global turn creates in an org
    // that need not be the current scope.
    expect(invalidatedKeys()).toEqual([['articles'], ['search']]);
  });

  it('a failed apply and a plain reject invalidate nothing', async () => {
    mountActions();
    await driveTurn();

    apiFetchMock.mockResolvedValueOnce({
      toolCall: { ...PENDING_CALL, status: 'failed', error: 'stale' },
      updatedToolCalls: [{ ...PENDING_CALL, status: 'failed', error: 'stale' }],
    });
    await act(async () => {
      screen.getByText('apply').click();
    });
    expect(invalidatedKeys()).toEqual([]);

    apiFetchMock.mockResolvedValueOnce({
      toolCall: { ...PENDING_CALL, status: 'rejected' },
      updatedToolCalls: [{ ...PENDING_CALL, status: 'rejected' }],
    });
    await act(async () => {
      screen.getByText('reject').click();
    });
    expect(invalidatedKeys()).toEqual([]);
  });

  // Reject-recovery: the server reports `applied` because a crashed
  // apply's article really exists. Keying on the settled status (not on
  // the action) is what makes this land without a special case.
  it('a reject that recovers a crashed create still invalidates', async () => {
    mountActions();
    await driveTurn();

    apiFetchMock.mockResolvedValueOnce({
      toolCall: { ...PENDING_CALL, status: 'applied', result: 'Created article "T".' },
      updatedToolCalls: [{ ...PENDING_CALL, status: 'applied', result: 'Created article "T".' }],
    });
    await act(async () => {
      screen.getByText('reject').click();
    });

    expect(screen.getByTestId('call-status')).toHaveTextContent('applied');
    expect(invalidatedKeys()).toEqual([['articles'], ['search']]);
  });

  it('the create sheet path DOES send companyId + full overrides', async () => {
    mountActions();
    await driveTurn();

    apiFetchMock.mockResolvedValueOnce({
      toolCall: { ...PENDING_CALL, status: 'applied', result: 'Created article "T".' },
      updatedToolCalls: [{ ...PENDING_CALL, status: 'applied', result: 'Created article "T".' }],
    });
    await act(async () => {
      screen.getByText('apply-create').click();
    });

    const [, init] = apiFetchMock.mock.calls[apiFetchMock.mock.calls.length - 1]!;
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      companyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createOverrides: { title: 'T', folderId: null, visibleToClients: false },
    });
  });

  it('a server-side failed apply settles as failure — never success', async () => {
    mountActions();
    await driveTurn();

    apiFetchMock.mockResolvedValueOnce({
      toolCall: { ...PENDING_CALL, status: 'failed', error: 'Missing article.write permission.' },
      updatedToolCalls: [
        { ...PENDING_CALL, status: 'failed', error: 'Missing article.write permission.' },
      ],
    });
    await act(async () => {
      screen.getByText('apply').click();
    });

    expect(screen.getByTestId('call-status')).toHaveTextContent('failed');
  });

  it('the already-settled 400 race resyncs from the conversation without an error line', async () => {
    const { ApiError } = jest.requireActual('../../lib/api') as {
      ApiError: new (status: number, problem: unknown) => Error;
    };
    mountActions();
    await driveTurn();

    apiFetchMock
      .mockRejectedValueOnce(new ApiError(400, { detail: 'Tool call is already applied' }))
      .mockResolvedValueOnce({
        id: 'c1',
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'done',
            createdAt: 'now',
            toolCalls: [{ ...PENDING_CALL, status: 'applied', result: 'Edited.' }],
          },
        ],
      });
    await act(async () => {
      screen.getByText('apply').click();
    });

    expect(screen.getByTestId('call-status')).toHaveTextContent('applied');
    expect(screen.getByTestId('action-error')).toHaveTextContent('none');
    // The other device's apply mutated an article just as surely as a
    // local one would have.
    expect(invalidatedKeys()).toEqual([['articles'], ['search']]);
  });

  it('the create-recovery 400 resyncs the marker AND surfaces the message (code-driven)', async () => {
    const { ApiError } = jest.requireActual('../../lib/api') as {
      ApiError: new (status: number, problem: unknown) => Error;
    };
    mountActions();
    await driveTurn();

    const markerCall = {
      ...PENDING_CALL,
      pendingCreate: {
        articleId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        companyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        title: 'Original',
        folderId: null,
        visibleToClients: true,
      },
    };
    apiFetchMock
      .mockRejectedValueOnce(
        new ApiError(400, {
          code: 'article_create_recovery_pending',
          detail: 'A previous apply attempt is being completed; the original confirmation applies.',
        }),
      )
      .mockResolvedValueOnce({
        id: 'c1',
        messages: [
          { id: 'm1', role: 'assistant', content: 'x', createdAt: 'now', toolCalls: [markerCall] },
        ],
      });
    await act(async () => {
      screen.getByText('apply-create').click();
    });

    // Still pending (locked retry required), with the honest message.
    expect(screen.getByTestId('call-status')).toHaveTextContent('pending');
    expect(screen.getByTestId('action-error')).toHaveTextContent(
      /original confirmation applies/,
    );
  });

  it('a validation 400 that leaves the call PENDING surfaces its message (never swallowed)', async () => {
    const { ApiError } = jest.requireActual('../../lib/api') as {
      ApiError: new (status: number, problem: unknown) => Error;
    };
    mountActions();
    await driveTurn();

    apiFetchMock
      .mockRejectedValueOnce(new ApiError(400, { detail: 'title must be at most 200 characters' }))
      // Resync: the call is STILL pending — nothing settled elsewhere.
      .mockResolvedValueOnce({
        id: 'c1',
        messages: [
          { id: 'm1', role: 'assistant', content: 'x', createdAt: 'now', toolCalls: [PENDING_CALL] },
        ],
      });
    await act(async () => {
      screen.getByText('apply').click();
    });

    expect(screen.getByTestId('call-status')).toHaveTextContent('pending');
    expect(screen.getByTestId('action-error')).toHaveTextContent(
      'title must be at most 200 characters',
    );
    expect(screen.getByTestId('action')).toHaveTextContent('none');
  });

  it('rapid sibling actions: the second invocation no-ops while the first is in flight', async () => {
    mountActions();
    await driveTurn();

    let resolveApply: (v: unknown) => void = () => {};
    apiFetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveApply = resolve)),
    );
    const applyCallsBefore = apiFetchMock.mock.calls.length;

    await act(async () => {
      screen.getByText('apply').click();
    });
    await act(async () => {
      screen.getByText('apply-sibling').click();
    });

    // Only the FIRST action reached the network.
    expect(apiFetchMock.mock.calls.length).toBe(applyCallsBefore + 1);
    expect(screen.getByTestId('action')).toHaveTextContent('apply:tc-1');

    await act(async () => {
      resolveApply({
        toolCall: { ...PENDING_CALL, status: 'applied', result: 'ok' },
        updatedToolCalls: [{ ...PENDING_CALL, status: 'applied', result: 'ok' }],
      });
    });
    expect(screen.getByTestId('action')).toHaveTextContent('none');
  });

  it('post-meta transport recovery replaces the errored bubble with the persisted turn', async () => {
    mountActions();
    apiFetchMock.mockResolvedValueOnce({ id: 'c1' });
    act(() => {
      screen.getByText('seed').click();
    });
    await act(async () => {
      screen.getByText('send').click();
    });
    const stream = streamInvocations[streamInvocations.length - 1]!;

    apiFetchMock.mockResolvedValueOnce({
      id: 'c1',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'The persisted answer.',
          createdAt: 'now',
          toolCalls: [PENDING_CALL],
        },
      ],
    });
    await act(async () => {
      (stream.handlers.onMeta as (m: unknown) => void)({
        conversationId: 'c1',
        userMessageId: 'um1',
        assistantMessageId: 'm1',
        title: null,
      });
      (stream.handlers.onError as (m: string, o: string) => void)(
        'Connection lost.',
        'transport',
      );
    });

    expect(screen.getByTestId('last-text')).toHaveTextContent('The persisted answer.');
    expect(screen.getByTestId('call-status')).toHaveTextContent('pending');
  });

  it('scope matrix: null → id NOW resets; the boot adoption still does not', async () => {
    currentOrg = null;
    const view = mountActions();
    await driveTurn();
    expect(screen.getByTestId('count')).toHaveTextContent('2');

    currentOrg = ORG_A;
    view.rerender(withQuery(<ActionsHarness />));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });
});
