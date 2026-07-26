/**
 * @jest-environment jsdom
 */
/**
 * The TOTP budget rules (60/min, un-audited because the UI polls):
 * exactly one request per code window, zero requests while hidden,
 * and a visibility-return inside the window resumes WITHOUT a fetch.
 */
import { act, renderHook } from '@testing-library/react';
import { useTotpCode } from './use-totp';

jest.mock('./api', () => ({ fetchTotpCode: jest.fn() }));
const { fetchTotpCode } = jest.requireMock('./api') as {
  fetchTotpCode: jest.Mock;
};

const CO = 'co-1';
const PW = 'pw-1';

function totpResponse(validInMs: number) {
  return {
    code: '418902',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    validUntil: new Date(Date.now() + validInMs).toISOString(),
  };
}

/** jsdom has no real page-visibility switching; stub the getter. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchTotpCode.mockReset();
  setHiddenSilently(false);
});

afterEach(() => {
  jest.useRealTimers();
});

function setHiddenSilently(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
}

async function flush() {
  // Let the pending fetch promise settle inside act.
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useTotpCode', () => {
  it('fetches once on mount and schedules the refetch at validUntil + 200ms', async () => {
    fetchTotpCode.mockResolvedValueOnce(totpResponse(30_000));
    const { result } = renderHook(() =>
      useTotpCode({ companyId: CO, passwordId: PW, enabled: true }),
    );
    await flush();
    expect(fetchTotpCode).toHaveBeenCalledTimes(1);
    expect(result.current.code).toBe('418902');

    fetchTotpCode.mockResolvedValueOnce(totpResponse(30_000));
    // Just before the window boundary: nothing.
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(fetchTotpCode).toHaveBeenCalledTimes(1);
    // Cross validUntil + 200ms: exactly one more.
    await act(async () => {
      jest.advanceTimersByTime(250);
    });
    await flush();
    expect(fetchTotpCode).toHaveBeenCalledTimes(2);
  });

  it('stops entirely while hidden — no background burn', async () => {
    fetchTotpCode.mockResolvedValue(totpResponse(30_000));
    renderHook(() => useTotpCode({ companyId: CO, passwordId: PW, enabled: true }));
    await flush();
    expect(fetchTotpCode).toHaveBeenCalledTimes(1);

    setHidden(true);
    await act(async () => {
      jest.advanceTimersByTime(120_000); // four windows pass in the background
    });
    expect(fetchTotpCode).toHaveBeenCalledTimes(1);
  });

  it('resumes WITHOUT a request when the held code is still valid', async () => {
    fetchTotpCode.mockResolvedValue(totpResponse(30_000));
    renderHook(() => useTotpCode({ companyId: CO, passwordId: PW, enabled: true }));
    await flush();

    setHidden(true);
    await act(async () => {
      jest.advanceTimersByTime(5_000); // return inside the window
    });
    setHidden(false);
    await flush();
    expect(fetchTotpCode).toHaveBeenCalledTimes(1); // resumed, not refetched

    // …and the re-armed timer still fires at the original boundary.
    await act(async () => {
      jest.advanceTimersByTime(26_000);
    });
    await flush();
    expect(fetchTotpCode).toHaveBeenCalledTimes(2);
  });

  it('fetches immediately on return when the code expired while hidden', async () => {
    fetchTotpCode.mockResolvedValue(totpResponse(30_000));
    renderHook(() => useTotpCode({ companyId: CO, passwordId: PW, enabled: true }));
    await flush();

    setHidden(true);
    await act(async () => {
      jest.advanceTimersByTime(45_000); // past validUntil
    });
    expect(fetchTotpCode).toHaveBeenCalledTimes(1);

    setHidden(false);
    await flush();
    expect(fetchTotpCode).toHaveBeenCalledTimes(2);
  });

  it('tears down on unmount — a popped detail screen burns nothing', async () => {
    fetchTotpCode.mockResolvedValue(totpResponse(30_000));
    const { unmount } = renderHook(() =>
      useTotpCode({ companyId: CO, passwordId: PW, enabled: true }),
    );
    await flush();
    unmount();
    await act(async () => {
      jest.advanceTimersByTime(300_000);
    });
    expect(fetchTotpCode).toHaveBeenCalledTimes(1);
  });

  it('never fetches when disabled (no TOTP, or archived)', async () => {
    renderHook(() => useTotpCode({ companyId: CO, passwordId: PW, enabled: false }));
    await flush();
    expect(fetchTotpCode).not.toHaveBeenCalled();
  });

  it('dedupes load() across a hide/return while the request is still in flight', async () => {
    // Without the in-flight guard, returning before the first request
    // settles fires a second one; both completions arm timers but only
    // the latest is tracked — the orphan keeps firing as a duplicate
    // polling chain.
    let resolveFirst!: (v: ReturnType<typeof totpResponse>) => void;
    fetchTotpCode.mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r;
      }),
    );
    fetchTotpCode.mockResolvedValue(totpResponse(30_000));
    const { result } = renderHook(() =>
      useTotpCode({ companyId: CO, passwordId: PW, enabled: true }),
    );
    await flush();
    expect(fetchTotpCode).toHaveBeenCalledTimes(1);

    setHidden(true);
    setHidden(false); // back before the request settled → must dedupe
    await flush();
    expect(fetchTotpCode).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(totpResponse(30_000));
      await Promise.resolve();
    });
    expect(result.current.code).toBe('418902');

    // Exactly ONE refetch chain exists: one boundary, one request.
    await act(async () => {
      jest.advanceTimersByTime(30_250);
    });
    await flush();
    expect(fetchTotpCode).toHaveBeenCalledTimes(2);
  });

  it('a request resolving while hidden arms nothing until return', async () => {
    let resolveFirst!: (v: ReturnType<typeof totpResponse>) => void;
    fetchTotpCode.mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r;
      }),
    );
    fetchTotpCode.mockResolvedValue(totpResponse(30_000));
    renderHook(() => useTotpCode({ companyId: CO, passwordId: PW, enabled: true }));
    await flush();

    setHidden(true);
    await act(async () => {
      resolveFirst(totpResponse(30_000));
      await Promise.resolve();
    });

    // Four windows pass in the background: no refetch chain may exist.
    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    expect(fetchTotpCode).toHaveBeenCalledTimes(1);

    // On return the held code has expired → exactly one fetch resumes.
    setHidden(false);
    await flush();
    expect(fetchTotpCode).toHaveBeenCalledTimes(2);
  });

  it('drops the stale code on a refresh failure and retries — never offers an expired code', async () => {
    fetchTotpCode.mockResolvedValueOnce(totpResponse(30_000));
    const { result } = renderHook(() =>
      useTotpCode({ companyId: CO, passwordId: PW, enabled: true }),
    );
    await flush();
    expect(result.current.code).toBe('418902');

    // Window rolls over; the refresh fails.
    fetchTotpCode.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      jest.advanceTimersByTime(30_250);
    });
    await flush();
    // The expired code must NOT stay copyable on screen.
    expect(result.current.code).toBeNull();
    expect(result.current.failed).toBe(true);

    // Bounded retry recovers on its own.
    fetchTotpCode.mockResolvedValueOnce(totpResponse(30_000));
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await flush();
    expect(result.current.code).toBe('418902');
    expect(result.current.failed).toBe(false);
    expect(fetchTotpCode).toHaveBeenCalledTimes(3);
  });
});
