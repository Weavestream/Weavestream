import { ApiError, StepUpCancelledError, apiFetch, isRestrictedError } from './api';

jest.mock('@weavestream/shared/browser', () => ({ ensureCsrf: jest.fn() }));
const { ensureCsrf } = jest.requireMock('@weavestream/shared/browser') as {
  ensureCsrf: jest.Mock;
};

describe('isRestrictedError', () => {
  const stepUpProblem = { status: 403, code: 'step_up_required', factor: 'password' };

  it('matches a 403 that is neither a step-up demand nor a step-up cancel', () => {
    expect(isRestrictedError(new ApiError(403, { detail: 'not on allow-list' }))).toBe(true);
    expect(isRestrictedError(new ApiError(403, stepUpProblem))).toBe(false);
    expect(isRestrictedError(new StepUpCancelledError(stepUpProblem))).toBe(false);
    expect(isRestrictedError(new ApiError(404, null))).toBe(false);
    expect(isRestrictedError(new Error('x'))).toBe(false);
  });
});

describe('apiFetch CSRF acquisition (5a parity pin)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  it('threads the request signal into ensureCsrf and rethrows its abort UNCHANGED', async () => {
    // Mobile's contract is the inverse of web's: web maps AbortError to
    // its `{problem:{aborted:true}}` sentinel; this client must rethrow
    // the platform error untouched so TanStack Query recognises its own
    // cancellation.
    const ctrl = new AbortController();
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    ensureCsrf.mockRejectedValueOnce(abortErr);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    ctrl.abort();

    await expect(
      apiFetch('/things', { method: 'POST', body: '{}', signal: ctrl.signal }),
    ).rejects.toBe(abortErr); // identity — not wrapped, not sentinel'd
    expect(ensureCsrf).toHaveBeenCalledWith(ctrl.signal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
