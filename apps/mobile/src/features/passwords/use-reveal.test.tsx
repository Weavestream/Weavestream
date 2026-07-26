/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ToastProvider } from '../../components/Toast';
import { ApiError } from '../../lib/api';
import { REVEAL_AUTO_HIDE_MS, useReveal } from './use-reveal';

jest.mock('./api', () => {
  const actual = jest.requireActual('./api');
  return { ...actual, revealPassword: jest.fn() };
});
jest.mock('./copy', () => ({ copySecret: jest.fn() }));
jest.mock('./clipboard-guard', () => ({
  consumeUniversalClipboardNotice: jest.fn(() => false),
}));
jest.mock('../../lib/navigate', () => ({ redirectToLogin: jest.fn() }));

const { revealPassword } = jest.requireMock('./api') as { revealPassword: jest.Mock };
const { copySecret } = jest.requireMock('./copy') as { copySecret: jest.Mock };

const wrapper = ({ children }: { children: ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);

function mount(over: Partial<Parameters<typeof useReveal>[0]> = {}) {
  return renderHook(
    (props: Parameters<typeof useReveal>[0]) => useReveal(props),
    {
      wrapper,
      initialProps: {
        companyId: 'co-1',
        passwordId: 'pw-1',
        requireReason: false,
        resetKey: 'v1',
        ...over,
      },
    },
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  revealPassword.mockReset();
  copySecret.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useReveal', () => {
  it('reveals on toggle and auto-hides after 30 s', async () => {
    revealPassword.mockResolvedValue({ password: 's3cret' });
    const { result } = mount();

    act(() => result.current.toggleReveal());
    await flush();
    expect(result.current.plaintext).toBe('s3cret');

    await act(async () => {
      jest.advanceTimersByTime(REVEAL_AUTO_HIDE_MS - 1_000);
    });
    expect(result.current.plaintext).toBe('s3cret');

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(result.current.plaintext).toBeNull();
  });

  it('clears the plaintext the moment the app is backgrounded', async () => {
    revealPassword.mockResolvedValue({ password: 's3cret' });
    const { result } = mount();
    act(() => result.current.toggleReveal());
    await flush();

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.plaintext).toBeNull();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('opens the reason sheet BEFORE any request when the flag is known', () => {
    const { result } = mount({ requireReason: true });
    act(() => result.current.toggleReveal());
    expect(result.current.sheet?.action).toBe('view');
    expect(revealPassword).not.toHaveBeenCalled();
  });

  it('opens the sheet reactively on a ReasonRequired response', async () => {
    revealPassword.mockRejectedValue(
      new ApiError(400, { error: 'ReasonRequired' }),
    );
    const { result } = mount(); // flag NOT set on the cached record
    act(() => result.current.toggleReveal());
    await flush();
    expect(result.current.sheet?.action).toBe('view');
  });

  it('surfaces the allow-list 403 with its own copy, not a generic error', async () => {
    revealPassword.mockRejectedValue(
      new ApiError(403, { detail: 'you are not on this credential’s allow-list' }),
    );
    const { result } = mount();
    render(<div />, { wrapper }); // nothing — toast renders inside the hook wrapper
    act(() => result.current.toggleReveal());
    await flush();
    expect(result.current.sheet).toBeNull();
    expect(
      screen.getByText('You don’t have access to this credential.'),
    ).toBeInTheDocument();
  });

  it('a fresh edit (resetKey change) flushes the cached plaintext', async () => {
    revealPassword.mockResolvedValue({ password: 's3cret' });
    const { result, rerender } = mount();
    act(() => result.current.toggleReveal());
    await flush();
    expect(result.current.plaintext).toBe('s3cret');

    rerender({
      companyId: 'co-1',
      passwordId: 'pw-1',
      requireReason: false,
      resetKey: 'v2',
    });
    expect(result.current.plaintext).toBeNull();
  });

  it('copy with a held plaintext short-circuits to the cached path', async () => {
    revealPassword.mockResolvedValue({ password: 's3cret' });
    copySecret.mockResolvedValue({ ok: true });
    const { result } = mount({ requireReason: true });

    // Reveal first (via the sheet), then copy — no second prompt: the
    // audited reveal already happened.
    act(() => result.current.toggleReveal());
    act(() => result.current.submitReason('ticket #1'));
    await flush();
    expect(result.current.plaintext).toBe('s3cret');

    act(() => result.current.copyTap());
    await flush();
    expect(copySecret).toHaveBeenCalledWith(
      expect.objectContaining({ cached: 's3cret' }),
    );
  });

  it('the sheet submit for copy hands the reason into the copy executor', async () => {
    copySecret.mockResolvedValue({ ok: true });
    const { result } = mount({ requireReason: true });

    act(() => result.current.copyTap());
    expect(result.current.sheet?.action).toBe('copy');
    expect(copySecret).not.toHaveBeenCalled();

    act(() => result.current.submitReason('ticket #42'));
    expect(copySecret).toHaveBeenCalledTimes(1);
    await flush();
    expect(result.current.sheet).toBeNull();

    // The fetch closure carries the reason through to the reveal call.
    revealPassword.mockResolvedValue({ password: 'x' });
    const { fetch } = copySecret.mock.calls[0]![0] as { fetch: () => Promise<string> };
    await fetch();
    expect(revealPassword).toHaveBeenCalledWith('co-1', 'pw-1', { reason: 'ticket #42' });
  });
});
