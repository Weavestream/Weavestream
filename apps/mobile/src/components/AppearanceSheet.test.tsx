/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppearanceSheet } from './AppearanceSheet';
import type { Me } from '../screens/TabShell';

jest.mock('../lib/api', () => ({ apiFetch: jest.fn() }));
jest.mock('../lib/ui-prefs', () => ({
  applyUiPrefs: jest.fn(),
  persistLocalUiPrefs: jest.fn(),
}));
const pushToast = jest.fn();
jest.mock('./Toast', () => ({ useToast: () => ({ push: pushToast }) }));

import { apiFetch } from '../lib/api';
import { applyUiPrefs, persistLocalUiPrefs } from '../lib/ui-prefs';

const apiFetchMock = apiFetch as jest.Mock;
const applyMock = applyUiPrefs as jest.Mock;
const persistMock = persistLocalUiPrefs as jest.Mock;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ME: Me = {
  id: 'u1',
  email: 'tech@example.com',
  role: 'MEMBER' as Me['role'],
  globalAccess: null,
  platformCapabilities: [],
  memberships: [],
  preferences: { uiTheme: 'light', uiAccent: 'lime', showItemCounts: false },
};

function renderSheet() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(['me'], ME);
  render(
    <QueryClientProvider client={qc}>
      <AppearanceSheet open onClose={() => {}} />
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AppearanceSheet', () => {
  it('reflects the account preferences as the initial selection', () => {
    renderSheet();
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'lime' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Three theme segments + five swatches.
    expect(screen.getAllByRole('radio')).toHaveLength(8);
  });

  it('applies instantly and PATCHes the full pair', async () => {
    const call = deferred<unknown>();
    apiFetchMock.mockReturnValueOnce(call.promise);
    renderSheet();

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(applyMock).toHaveBeenCalledWith({ uiTheme: 'dark', uiAccent: 'lime' });
    expect(apiFetchMock).toHaveBeenCalledWith('/me/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ uiTheme: 'dark', uiAccent: 'lime' }),
    });

    await act(async () => {
      call.resolve({});
      await call.promise;
    });
    expect(persistMock).toHaveBeenCalledWith({
      uiTheme: 'dark',
      uiAccent: 'lime',
    });
  });

  it('serializes writes: a tap burst costs at most two requests, the trailing one carrying the final selection', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    apiFetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderSheet();

    fireEvent.click(screen.getByRole('radio', { name: 'iris' }));
    fireEvent.click(screen.getByRole('radio', { name: 'coral' }));
    fireEvent.click(screen.getByRole('radio', { name: 'teal' }));

    // Only the first request has fired; the two later taps just moved
    // the desired state.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({});
      await first.promise;
    });

    // The follow-up carries the FINAL selection, skipping coral.
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(apiFetchMock).toHaveBeenLastCalledWith('/me/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ uiTheme: 'light', uiAccent: 'teal' }),
    });

    await act(async () => {
      second.resolve({});
      await second.promise;
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(persistMock).toHaveBeenLastCalledWith({
      uiTheme: 'light',
      uiAccent: 'teal',
    });
  });

  it('an older failure never clobbers a newer selection', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    apiFetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderSheet();

    fireEvent.click(screen.getByRole('radio', { name: 'iris' }));
    fireEvent.click(screen.getByRole('radio', { name: 'teal' }));

    await act(async () => {
      first.reject(new Error('boom'));
      await first.promise.catch(() => {});
    });

    // No revert, no toast — the follow-up send owns the outcome.
    expect(pushToast).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'teal' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({});
      await second.promise;
    });
    expect(persistMock).toHaveBeenLastCalledWith({
      uiTheme: 'light',
      uiAccent: 'teal',
    });
  });

  it('reverts to the last confirmed preference when the trailing request fails', async () => {
    const call = deferred<unknown>();
    apiFetchMock.mockReturnValueOnce(call.promise);
    renderSheet();

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    await act(async () => {
      call.reject(new Error('boom'));
      await call.promise.catch(() => {});
    });

    expect(pushToast).toHaveBeenCalledWith(
      'Couldn’t save appearance. Try again.',
      'danger',
    );
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // The revert is a full publication (DOM + cookie + shell + cache
    // ride persistLocalUiPrefs) so local state lands on what the
    // server actually holds.
    expect(persistMock).toHaveBeenCalledWith({
      uiTheme: 'light',
      uiAccent: 'lime',
    });
  });

  it('an intermediate confirmation never restamps the older choice while a newer tap is queued', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    apiFetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const qc = renderSheet();

    fireEvent.click(screen.getByRole('radio', { name: 'iris' }));
    fireEvent.click(screen.getByRole('radio', { name: 'teal' }));

    await act(async () => {
      first.resolve({});
      await first.promise;
    });

    // iris confirmed while teal is queued: nothing published — the DOM
    // keeps showing teal and cookie/cache are untouched until the
    // trailing send settles.
    expect(persistMock).not.toHaveBeenCalled();
    expect(qc.getQueryData<Me>(['me'])?.preferences?.uiAccent).toBe('lime');

    await act(async () => {
      second.resolve({});
      await second.promise;
    });
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledWith({
      uiTheme: 'light',
      uiAccent: 'teal',
    });
    expect(qc.getQueryData<Me>(['me'])?.preferences?.uiAccent).toBe('teal');
  });

  it('a failed trailing request publishes the intermediate pair its own success skipped', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    apiFetchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const qc = renderSheet();

    fireEvent.click(screen.getByRole('radio', { name: 'iris' }));
    fireEvent.click(screen.getByRole('radio', { name: 'teal' }));

    await act(async () => {
      first.resolve({});
      await first.promise;
    });
    await act(async () => {
      second.reject(new Error('boom'));
      await second.promise.catch(() => {});
    });

    // Server holds iris (first PATCH succeeded); the UI reverts there
    // and the deferred publication now lands: DOM, cookie, and cache
    // all agree with the server.
    expect(screen.getByRole('radio', { name: 'iris' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledWith({
      uiTheme: 'light',
      uiAccent: 'iris',
    });
    expect(qc.getQueryData<Me>(['me'])?.preferences?.uiAccent).toBe('iris');
    expect(pushToast).toHaveBeenCalledTimes(1);
  });

  it('merges the confirmed pair into the me cache', async () => {
    apiFetchMock.mockResolvedValueOnce({});
    const qc = renderSheet();

    fireEvent.click(screen.getByRole('radio', { name: 'amber' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(qc.getQueryData<Me>(['me'])?.preferences).toEqual({
      uiTheme: 'light',
      uiAccent: 'amber',
      showItemCounts: false,
    });
  });
});
