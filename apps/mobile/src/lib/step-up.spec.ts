/**
 * Step-up interception in `apiFetch`, plus the coordinator's contract.
 *
 * No Phase 1 screen triggers step-up (reveal is Phase 2), so these tests
 * are the only thing standing between the coordinator and Phase 2
 * discovering its edge cases in a server closet. The cases that matter:
 * exactly one prompt per burst, exactly one replay, a cancellation that is
 * distinguishable from a refusal, and no replay of a body that has already
 * been consumed.
 */
import { ApiError, StepUpCancelledError, apiFetch } from './api';
import {
  cancelPendingStepUp,
  hasPendingStepUp,
  hasStepUpOpener,
  registerStepUpOpener,
  requestStepUp,
} from './step-up';

jest.mock('@weavestream/shared/browser', () => ({
  ensureCsrf: jest.fn().mockResolvedValue('csrf-token'),
}));

const STEP_UP_BODY = {
  type: 'https://weavestream.app/problems/403',
  title: 'Forbidden',
  status: 403,
  detail: 'Step-up authentication required',
  code: 'step_up_required',
  factor: 'mfa',
};

function jsonResponse(status: number, body: unknown, problem = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: () =>
        problem ? 'application/problem+json' : 'application/json; charset=utf-8',
    },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Spin the microtask/timer queue until `predicate` holds, or give up. */
async function waitFor(predicate: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('waitFor: condition never became true');
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  registerStepUpOpener(null, null);
});

afterEach(() => {
  registerStepUpOpener(null, null);
});

describe('apiFetch step-up interception', () => {
  it('prompts once and replays the request exactly once on success', async () => {
    const open = jest.fn().mockResolvedValue(true);
    registerStepUpOpener(open, jest.fn());

    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, STEP_UP_BODY, true))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(apiFetch('/passwords/1/reveal', { method: 'POST' })).resolves.toEqual(
      { ok: true },
    );

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('mfa');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not prompt a second time if the replay is also challenged', async () => {
    // Otherwise a server that answers `step_up_required` unconditionally
    // would loop the prompt forever.
    const open = jest.fn().mockResolvedValue(true);
    registerStepUpOpener(open, jest.fn());

    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, STEP_UP_BODY, true))
      .mockResolvedValueOnce(jsonResponse(403, STEP_UP_BODY, true));

    await expect(apiFetch('/x', { method: 'POST' })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws StepUpCancelledError when the user declines', async () => {
    // Distinct from a plain 403 so a deliberate Cancel does not surface as
    // "the server refused you".
    registerStepUpOpener(jest.fn().mockResolvedValue(false), jest.fn());
    fetchMock.mockResolvedValueOnce(jsonResponse(403, STEP_UP_BODY, true));

    const err: unknown = await apiFetch('/x', { method: 'POST' }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StepUpCancelledError);
    // Still an ApiError with a 403, so the retry predicate and the 401
    // handler keep behaving correctly.
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a plain ApiError when no host is mounted', async () => {
    // "There was no prompt to decline" is a broken step-up path, not a
    // user choice, and must not be reported as one.
    fetchMock.mockResolvedValueOnce(jsonResponse(403, STEP_UP_BODY, true));

    const err = await apiFetch('/x', { method: 'POST' }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(StepUpCancelledError);
  });

  it('does not replay a body that has already been consumed', async () => {
    // FormData is a one-shot stream; replaying it would send an empty
    // body. Surfacing the 403 is the honest outcome.
    const open = jest.fn().mockResolvedValue(true);
    registerStepUpOpener(open, jest.fn());
    fetchMock.mockResolvedValueOnce(jsonResponse(403, STEP_UP_BODY, true));

    await expect(
      apiFetch('/uploads', { method: 'POST', body: new FormData() }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(open).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a 403 that is not a step-up challenge alone', async () => {
    const open = jest.fn();
    registerStepUpOpener(open, jest.fn());
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { status: 403, detail: 'Forbidden' }, true),
    );

    await expect(apiFetch('/x')).rejects.toBeInstanceOf(ApiError);
    expect(open).not.toHaveBeenCalled();
  });

  it('defaults the factor to password when the problem omits it', async () => {
    const open = jest.fn().mockResolvedValue(true);
    registerStepUpOpener(open, jest.fn());
    const { factor: _factor, ...noFactor } = STEP_UP_BODY;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(403, noFactor, true))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiFetch('/x', { method: 'POST' });

    expect(open).toHaveBeenCalledWith('password');
  });
});

describe('step-up coordinator', () => {
  it('joins concurrent callers onto a single prompt', async () => {
    // A screen that fires several blocked requests at once must not stack
    // sheets.
    let resolveOpen: ((ok: boolean) => void) | undefined;
    const open = jest.fn(
      () => new Promise<boolean>((r) => (resolveOpen = r)),
    );
    registerStepUpOpener(open, jest.fn());

    const a = requestStepUp('mfa');
    const b = requestStepUp('mfa');
    const c = requestStepUp('mfa');

    expect(open).toHaveBeenCalledTimes(1);
    resolveOpen!(true);
    await expect(Promise.all([a, b, c])).resolves.toEqual([true, true, true]);
  });

  it('reports whether a host is available', () => {
    expect(hasStepUpOpener()).toBe(false);
    registerStepUpOpener(jest.fn(), jest.fn());
    expect(hasStepUpOpener()).toBe(true);
    registerStepUpOpener(null, null);
    expect(hasStepUpOpener()).toBe(false);
  });

  it('resolves false immediately when no host is registered', async () => {
    await expect(requestStepUp('mfa')).resolves.toBe(false);
  });

  it('clears the pending prompt after it settles, so a later one prompts fresh', async () => {
    // A stranded `pending` would make every later caller await a promise
    // that never settles.
    const open = jest.fn().mockResolvedValue(true);
    registerStepUpOpener(open, jest.fn());

    await requestStepUp('mfa');
    expect(hasPendingStepUp()).toBe(false);

    await requestStepUp('mfa');
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('clears the pending prompt even when the opener rejects', async () => {
    const open = jest.fn().mockRejectedValue(new Error('boom'));
    registerStepUpOpener(open, jest.fn());

    await expect(requestStepUp('mfa')).rejects.toThrow('boom');
    expect(hasPendingStepUp()).toBe(false);
  });

  it('cancelPendingStepUp invokes the registered canceller', async () => {
    // The coordinator cannot close the sheet or settle the host's resolver
    // itself, which is why cancellation is registered rather than assumed.
    let settle: ((ok: boolean) => void) | undefined;
    const open = jest.fn(() => new Promise<boolean>((r) => (settle = r)));
    const cancel = jest.fn(() => settle?.(false));
    registerStepUpOpener(open, cancel);

    const pending = requestStepUp('mfa');
    expect(hasPendingStepUp()).toBe(true);

    cancelPendingStepUp();

    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe(false);
    expect(hasPendingStepUp()).toBe(false);
  });

  it('cancelPendingStepUp is a no-op when nothing is pending', () => {
    const cancel = jest.fn();
    registerStepUpOpener(jest.fn(), cancel);

    cancelPendingStepUp();

    expect(cancel).not.toHaveBeenCalled();
  });

  it('unregistering does not strand a pending waiter', async () => {
    // The host settles its resolver in its own cleanup; this asserts the
    // coordinator cooperates — `pending` must clear so the *next* step-up
    // gets a fresh prompt rather than joining a promise nobody will resolve.
    let settle: ((ok: boolean) => void) | undefined;
    const unregister = registerStepUpOpener(
      () => new Promise<boolean>((r) => (settle = r)),
      () => settle?.(false),
    );

    const inflight = requestStepUp('mfa');
    expect(hasPendingStepUp()).toBe(true);

    // What the host's cleanup does, in order.
    unregister();
    settle!(false);

    await expect(inflight).resolves.toBe(false);
    expect(hasPendingStepUp()).toBe(false);
    expect(hasStepUpOpener()).toBe(false);
  });

  it('a stale unregister cannot clear a newer registration', async () => {
    // React StrictMode mounts, cleans up, then remounts. An unconditional
    // cleanup would run after the remount had already registered and leave
    // the app with no opener — a step-up that silently never prompts.
    const staleUnregister = registerStepUpOpener(jest.fn(), jest.fn());

    const freshOpen = jest.fn().mockResolvedValue(true);
    registerStepUpOpener(freshOpen, jest.fn());

    staleUnregister();

    expect(hasStepUpOpener()).toBe(true);
    await expect(requestStepUp('mfa')).resolves.toBe(true);
    expect(freshOpen).toHaveBeenCalledTimes(1);
  });

  it('a cancelled request does not replay — navigation cannot resurrect it', async () => {
    // End to end: a blocked request, a prompt, then the user navigates.
    // The host cancels; the original request must reject and fire no retry.
    let settle: ((ok: boolean) => void) | undefined;
    registerStepUpOpener(
      () => new Promise<boolean>((r) => (settle = r)),
      () => settle?.(false),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(403, STEP_UP_BODY, true));

    const inflight = apiFetch('/passwords/1/reveal', { method: 'POST' }).catch(
      (e) => e,
    );
    // Wait for the interception to actually reach `requestStepUp` rather
    // than guessing a number of microtasks — `ensureCsrf`, the fetch and
    // the body parse each add one, and a wrong count makes this test hang
    // rather than fail.
    await waitFor(() => hasPendingStepUp());

    cancelPendingStepUp();

    expect(await inflight).toBeInstanceOf(StepUpCancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
