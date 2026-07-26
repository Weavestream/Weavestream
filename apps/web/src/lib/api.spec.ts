import { apiFetch } from './api';

const requestStepUp = jest.fn();
const hasStepUpOpener = jest.fn();

jest.mock('@weavestream/shared/browser', () => ({
  ensureCsrf: async () => 'csrf-token',
}));
// `isStepUpProblem` is deliberately NOT mocked — it now lives in
// `@weavestream/shared`, which loads for real here, so these tests
// exercise the actual `step_up_required` narrowing rather than a
// local re-implementation that could drift from it.
jest.mock('./step-up', () => ({
  requestStepUp: (...a: unknown[]) => requestStepUp(...a),
  hasStepUpOpener: () => hasStepUpOpener(),
}));

/** Minimal Response stand-in — apiFetch only touches these four members. */
function response(status: number, body: unknown, contentType: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    json: async () => body,
  };
}

const stepUp403 = () =>
  response(403, { code: 'step_up_required', factor: 'mfa' }, 'application/problem+json');

/**
 * `stepUpCancelled` exists to separate three outcomes that all hand the
 * caller an identical `403 step_up_required` body. Callers use it to stay
 * silent on a deliberate dismissal, so anything else leaking the flag
 * would silently swallow a real failure.
 */
describe('apiFetch step-up cancellation signal', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as never;
  });

  it('flags a prompt the user was shown and dismissed', async () => {
    fetchMock.mockResolvedValue(stepUp403());
    hasStepUpOpener.mockReturnValue(true);
    requestStepUp.mockResolvedValue(false);

    const res = await apiFetch('/me/mfa/backup-codes/regenerate', { method: 'POST' });

    expect(res.stepUpCancelled).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT flag when no modal was available to dismiss', async () => {
    // Provider unmounted: `requestStepUp` resolves false without ever
    // showing anything. That is a broken step-up path, not a user choice.
    fetchMock.mockResolvedValue(stepUp403());
    hasStepUpOpener.mockReturnValue(false);
    requestStepUp.mockResolvedValue(false);

    const res = await apiFetch('/me/mfa/backup-codes/regenerate', { method: 'POST' });

    expect(res.stepUpCancelled).toBeUndefined();
    expect(res.ok).toBe(false);
  });

  it('does NOT flag when the post-confirmation retry stays blocked', async () => {
    // Step-up succeeded but the server refused anyway. The retry carries
    // `__stepUpRetried`, so it never re-enters the prompt branch.
    fetchMock.mockResolvedValue(stepUp403());
    hasStepUpOpener.mockReturnValue(true);
    requestStepUp.mockResolvedValue(true);

    const res = await apiFetch('/me/mfa/backup-codes/regenerate', { method: 'POST' });

    expect(res.stepUpCancelled).toBeUndefined();
    expect(res.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestStepUp).toHaveBeenCalledTimes(1);
  });

  it('retries once and returns the payload when step-up succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(stepUp403())
      .mockResolvedValueOnce(response(200, { backupCodes: ['AAAAA-BBBBB'] }, 'application/json'));
    hasStepUpOpener.mockReturnValue(true);
    requestStepUp.mockResolvedValue(true);

    const res = await apiFetch<{ backupCodes: string[] }>(
      '/me/mfa/backup-codes/regenerate',
      { method: 'POST' },
    );

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ backupCodes: ['AAAAA-BBBBB'] });
    expect(res.stepUpCancelled).toBeUndefined();
  });

  it('leaves an unrelated failure untouched', async () => {
    // A non-step-up problem must never acquire the flag, or callers that
    // treat it as "cancelled" would drop a genuine error.
    fetchMock.mockResolvedValue(
      response(500, { title: 'Internal Server Error' }, 'application/problem+json'),
    );
    hasStepUpOpener.mockReturnValue(true);

    const res = await apiFetch('/me/mfa/backup-codes/regenerate', { method: 'POST' });

    expect(res.stepUpCancelled).toBeUndefined();
    expect(res.status).toBe(500);
    expect(requestStepUp).not.toHaveBeenCalled();
  });
});
