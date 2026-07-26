import { ApiError, shouldRetry } from './api';

jest.mock('@weavestream/shared/browser', () => ({
  ensureCsrf: async () => 'csrf-token',
}));

const { login, verifyMfa, sessionUsable, logout } = jest.requireActual<
  typeof import('./auth')
>('./auth');

/** Minimal Response stand-in — apiFetch touches only these members. */
function response(status: number, body: unknown, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k === 'content-type' ? contentType : null) },
    json: async () => body,
  } as unknown as Response;
}

let fetchSpy: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});
afterEach(() => jest.restoreAllMocks());

describe('login', () => {
  it('routes a plain success to the app', async () => {
    fetchSpy.mockResolvedValue(
      response(200, {
        mfaSetupRequired: false,
        mfaChallengeRequired: false,
        user: { id: 'u1', email: 'a@b.c' },
      }),
    );
    await expect(login('a@b.c', 'pw')).resolves.toEqual({ kind: 'ok' });
  });

  it('routes mfaChallengeRequired to the challenge screen', async () => {
    fetchSpy.mockResolvedValue(
      response(200, {
        mfaSetupRequired: false,
        mfaChallengeRequired: true,
        user: { id: 'u1', email: 'a@b.c' },
      }),
    );
    await expect(login('a@b.c', 'pw')).resolves.toEqual({
      kind: 'mfa-challenge',
    });
  });

  it('routes mfaSetupRequired to the desktop hand-off, not to enrolment', async () => {
    fetchSpy.mockResolvedValue(
      response(200, {
        mfaSetupRequired: true,
        mfaChallengeRequired: false,
        user: { id: 'u1', email: 'a@b.c' },
      }),
    );
    await expect(login('a@b.c', 'pw')).resolves.toEqual({ kind: 'mfa-setup' });
  });

  // The 401 here is a wrong password. It must surface inline rather than
  // travelling the "session is gone" path — see the query-client specs.
  it('reports invalid credentials on 401 without redirecting', async () => {
    fetchSpy.mockResolvedValue(
      response(401, { code: 'invalid_credentials' }, 'application/problem+json'),
    );
    await expect(login('a@b.c', 'bad')).resolves.toEqual({
      kind: 'error',
      message: 'Invalid credentials.',
    });
  });

  it('reports throttling separately on 429', async () => {
    fetchSpy.mockResolvedValue(response(429, {}, 'application/problem+json'));
    await expect(login('a@b.c', 'pw')).resolves.toEqual({
      kind: 'error',
      message: 'Too many attempts. Try again later.',
    });
  });

  /**
   * An outage must not be reported as a bad password. Telling a
   * technician their credentials are wrong during an API failure sends
   * them to re-type a password that was correct — and on a dead radio in
   * a server closet, that is exactly when they can least tell the
   * difference.
   */
  it('does not blame the credentials for a 5xx', async () => {
    fetchSpy.mockResolvedValue(response(503, {}, 'application/problem+json'));
    const out = (await login('a@b.c', 'pw')) as { message: string };
    expect(out.message).not.toMatch(/invalid/i);
    expect(out.message).toMatch(/trouble/i);
  });

  it('does not blame the credentials for a transport failure', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const out = (await login('a@b.c', 'pw')) as { message: string };
    expect(out.message).not.toMatch(/invalid/i);
    expect(out.message).toMatch(/connection/i);
  });
});

describe('verifyMfa', () => {
  it('resolves ok on success', async () => {
    fetchSpy.mockResolvedValue(response(200, { ok: true }));
    await expect(verifyMfa('123456')).resolves.toEqual({ kind: 'ok' });
  });

  /**
   * THE regression guard. `auth.service.ts` throws
   * `UnauthorizedException('Invalid MFA code')` — a 401 — for a wrong
   * code. If this ever routes to /m/login instead of reporting inline,
   * a technician gets bounced out of the challenge mid-flow with no
   * explanation.
   */
  it('reports an invalid code on 401 rather than treating it as a dead session', async () => {
    fetchSpy.mockResolvedValue(
      response(401, { code: 'invalid_mfa' }, 'application/problem+json'),
    );
    await expect(verifyMfa('000000')).resolves.toEqual({
      kind: 'error',
      message: 'Invalid code.',
    });
  });

  it('reports throttling separately on 429', async () => {
    fetchSpy.mockResolvedValue(response(429, {}, 'application/problem+json'));
    await expect(verifyMfa('000000')).resolves.toEqual({
      kind: 'error',
      message: 'Too many attempts. Try again later.',
    });
  });

  it('does not call a valid code invalid during an outage', async () => {
    fetchSpy.mockResolvedValue(response(503, {}, 'application/problem+json'));
    const out = (await verifyMfa('123456')) as { message: string };
    expect(out.message).not.toMatch(/invalid/i);
  });

  /**
   * `MfaVerifyDto` only accepts a 6-digit TOTP or a 10-char backup code,
   * so a half-typed code is rejected by the DTO with a **400** before the
   * code is ever compared. That is input validation, not a wrong secret,
   * and it must not surface as a generic "something went wrong".
   */
  it.each(['12345', '1234567', 'abc', '', '   '])(
    'catches a malformed code (%s) before it reaches the server',
    async (bad) => {
      const out = (await verifyMfa(bad)) as { message: string };
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out.message).toMatch(/6-digit|backup code/i);
    },
  );

  it.each(['123456', 'ABCDE-FGHJK', 'abcde fghjk'])(
    'lets a well-formed code (%s) through to the server',
    async (good) => {
      fetchSpy.mockResolvedValue(response(200, { ok: true }));
      await expect(verifyMfa(good)).resolves.toEqual({ kind: 'ok' });
      expect(fetchSpy).toHaveBeenCalled();
    },
  );

  it('surfaces the server validation message on a 400', async () => {
    fetchSpy.mockResolvedValue(
      response(
        400,
        { detail: 'token must be a 6-digit code or backup code' },
        'application/problem+json',
      ),
    );
    // Bypass the client-side guard with a well-formed value so the 400
    // path is what is under test.
    const out = (await verifyMfa('123456')) as { message: string };
    expect(out.message).toBe('token must be a 6-digit code or backup code');
  });
});

describe('logout', () => {
  it('reports success when the session is ended', async () => {
    fetchSpy.mockResolvedValue(response(200, { ok: true }));
    await expect(logout()).resolves.toEqual({ ok: true });
  });

  /**
   * The session cookie is HttpOnly, so ONLY this call can clear it. A
   * failure reported as success means the user is told they signed out
   * while the session is still live — anyone who reopens `/m/app` on
   * that device is authenticated. On a shared or handed-over phone that
   * is a silent exposure, so the caller must not navigate on `ok:false`.
   */
  it('reports FAILURE when the server rejects the request', async () => {
    fetchSpy.mockResolvedValue(response(500, {}, 'application/problem+json'));
    const out = await logout();
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/still active/i);
  });

  it('reports FAILURE when the network is down', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const out = await logout();
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/still active/i);
  });

  it('treats a 401 as success — the session was already gone', async () => {
    fetchSpy.mockResolvedValue(response(401, {}, 'application/problem+json'));
    await expect(logout()).resolves.toEqual({ ok: true });
  });
});

describe('sessionUsable', () => {
  it('is true when /auth/me succeeds — the desktop-enrolment resume path', async () => {
    fetchSpy.mockResolvedValue(response(200, { id: 'u1' }));
    await expect(sessionUsable()).resolves.toBe(true);
  });

  it('is false while enrolment is still outstanding', async () => {
    fetchSpy.mockResolvedValue(
      response(403, { code: 'mfa_enrollment_required' }, 'application/problem+json'),
    );
    await expect(sessionUsable()).resolves.toBe(false);
  });
});

describe('shouldRetry', () => {
  // Never retry a 401: AuthGuard.silentRefresh already had its chance to
  // rotate the cookie server-side, so a 401 that reaches the client means
  // the session is genuinely gone.
  it('does not retry a 401', () => {
    expect(shouldRetry(0, new ApiError(401, null))).toBe(false);
  });

  it('does not retry other 4xx', () => {
    expect(shouldRetry(0, new ApiError(403, null))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, null))).toBe(false);
  });

  it('retries 5xx and transport failures, up to twice', () => {
    expect(shouldRetry(0, new ApiError(503, null))).toBe(true);
    expect(shouldRetry(1, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, null))).toBe(false);
  });
});
