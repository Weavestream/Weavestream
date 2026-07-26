/** @jest-environment jsdom */
import {
  CLIPBOARD_CLEAR_MS,
  consumeUniversalClipboardNotice,
  resetClipboardGuardForTests,
  scheduleClipboardClear,
} from './clipboard-guard';

const writeText = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);

beforeAll(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

beforeEach(() => {
  jest.useFakeTimers();
  writeText.mockClear();
  writeText.mockResolvedValue(undefined);
  window.localStorage.clear();
});

afterEach(() => {
  resetClipboardGuardForTests();
  jest.useRealTimers();
});

describe('scheduleClipboardClear', () => {
  it('clears at the deadline, not before', () => {
    scheduleClipboardClear(1_000);
    jest.advanceTimersByTime(999);
    expect(writeText).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('');
  });

  it('a newer copy supersedes the older token — B is not wiped at A’s deadline', () => {
    scheduleClipboardClear(1_000);
    jest.advanceTimersByTime(500);
    scheduleClipboardClear(1_000); // copy B
    jest.advanceTimersByTime(500); // A's deadline passes
    expect(writeText).not.toHaveBeenCalled();
    jest.advanceTimersByTime(500); // B's deadline
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected write — the platform limitation, not an error', async () => {
    writeText.mockRejectedValueOnce(new DOMException('NotAllowed'));
    scheduleClipboardClear(1_000);
    jest.advanceTimersByTime(1_000);
    // Flush the rejection through the catch; an unhandled rejection
    // would fail the test run on its own.
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('re-attempts an overdue clear on return to visibility (suspended-timer case)', () => {
    scheduleClipboardClear(1_000);
    // Simulate iOS suspending JS: wall clock passes the deadline but the
    // timer never fired.
    jest.setSystemTime(Date.now() + 5_000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(writeText).toHaveBeenCalledTimes(1);
    // The stale timer eventually firing must not clear a second time.
    jest.advanceTimersByTime(10_000);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('exports the 60s default the copy executor uses', () => {
    expect(CLIPBOARD_CLEAR_MS).toBe(60_000);
  });
});

describe('consumeUniversalClipboardNotice', () => {
  it('fires exactly once per install', () => {
    expect(consumeUniversalClipboardNotice()).toBe(true);
    expect(consumeUniversalClipboardNotice()).toBe(false);
  });

  it('skips the notice when storage is unavailable rather than nagging forever', () => {
    const spy = jest
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('private mode');
      });
    expect(consumeUniversalClipboardNotice()).toBe(false);
    spy.mockRestore();
  });
});
