import {
  ApiError,
  StepUpCancelledError,
  apiErrorMessage,
  apiFetch,
  isRestrictedError,
} from './api';

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

/**
 * The extraction itself is `@weavestream/shared`'s and is tested there.
 * What is mobile-only — and what these cases pin — is the `ApiError`
 * unwrap: the shared helper takes `unknown`, so handing it `err` instead
 * of `err.problem` typechecks cleanly and then returns the fallback for
 * every error. The first case is the one that fails if that regresses.
 */

const FALLBACK = 'Couldn’t apply the change.';

describe('apiErrorMessage', () => {
  it('reads the problem body off an ApiError, not the error object', () => {
    const err = new ApiError(409, { detail: 'Folder is not empty' });
    expect(apiErrorMessage(err, FALLBACK)).toBe('Folder is not empty');
  });

  it('keeps the shared precedence', () => {
    expect(
      apiErrorMessage(new ApiError(400, { message: 'msg', title: 'Bad Request' }), FALLBACK),
    ).toBe('msg');
    expect(apiErrorMessage(new ApiError(400, { title: 'Bad Request' }), FALLBACK)).toBe(
      'Bad Request',
    );
  });

  it('falls back when the problem body carries no usable string', () => {
    expect(apiErrorMessage(new ApiError(500, undefined), FALLBACK)).toBe(FALLBACK);
    expect(apiErrorMessage(new ApiError(500, { detail: '   ' }), FALLBACK)).toBe(FALLBACK);
  });

  it('falls back for anything that is not an ApiError', () => {
    expect(apiErrorMessage(new Error('boom'), FALLBACK)).toBe(FALLBACK);
    expect(apiErrorMessage({ detail: 'not an ApiError' }, FALLBACK)).toBe(FALLBACK);
    expect(apiErrorMessage(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
