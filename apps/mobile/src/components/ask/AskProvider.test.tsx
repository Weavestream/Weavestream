/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
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
 *  - 401 routing on both the create POST and the stream.
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

function mount() {
  return render(
    <AskProvider>
      <Harness />
    </AskProvider>,
  );
}

async function flush() {
  await act(async () => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  streamInvocations.length = 0;
  currentOrg = ORG_A;
  apiFetchMock.mockResolvedValue({ id: 'conv-1' });
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
    view.rerender(
      <AskProvider>
        <Harness />
      </AskProvider>,
    );
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
