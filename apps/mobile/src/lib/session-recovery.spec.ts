import { ApiError } from './api';
import { recoveryRouteFor } from './session-recovery';

/**
 * A cold PWA launch goes straight to `/m/app` with no memory of how the
 * session got into its current state. `MfaEnrollmentGuard` 403s a
 * partially-authenticated session in two recoverable ways, and
 * `/auth/me` is not exempt from that guard — so without this mapping the
 * user hits a dead end behind a Retry button that can never succeed.
 */
const problem = (fields: { detail?: string; code?: string } = {}) => ({
  title: 'Forbidden',
  status: 403,
  ...fields,
});

describe('recoveryRouteFor — by stable problem code (the supported path)', () => {
  it('sends an unenrolled session to the desktop hand-off', () => {
    expect(
      recoveryRouteFor(
        new ApiError(403, problem({ code: 'mfa_enrollment_required' })),
      ),
    ).toBe('/mfa/setup');
  });

  it('sends an unverified session to the challenge screen', () => {
    expect(
      recoveryRouteFor(
        new ApiError(403, problem({ code: 'mfa_challenge_required' })),
      ),
    ).toBe('/mfa/challenge');
  });

  /**
   * The code wins over the prose, so rewording the server message cannot
   * change routing. This is the whole point of introducing it.
   */
  it('ignores contradictory prose when a code is present', () => {
    expect(
      recoveryRouteFor(
        new ApiError(
          403,
          problem({ code: 'mfa_challenge_required', detail: 'enrollment blah' }),
        ),
      ),
    ).toBe('/mfa/challenge');
  });

  /**
   * The important negative. A genuine authorization denial must NOT be
   * turned into a credential prompt — that hides the real fault behind a
   * login screen that will appear to "work".
   */
  it('leaves a non-MFA coded 403 alone', () => {
    expect(
      recoveryRouteFor(new ApiError(403, problem({ code: 'forbidden' }))),
    ).toBeNull();
    expect(
      recoveryRouteFor(new ApiError(403, problem({ code: 'step_up_required' }))),
    ).toBeNull();
  });
});

describe('recoveryRouteFor — prose fallback (pre-code servers)', () => {
  it.each([
    ['MFA enrollment required', '/mfa/setup'],
    ['MFA enrolment required', '/mfa/setup'],
    ['MFA challenge required', '/mfa/challenge'],
  ])('routes %s to %s', (detail, expected) => {
    expect(recoveryRouteFor(new ApiError(403, problem({ detail })))).toBe(
      expected,
    );
  });

  /**
   * The documented default, and the bug this replaced: an earlier version
   * returned `null` for unrecognised prose, which recreated the terminal
   * 403 screen the moment server wording changed. Login always recovers,
   * because it re-derives the MFA state authoritatively.
   */
  it('falls back to login for an unrecognised uncoded 403', () => {
    expect(
      recoveryRouteFor(new ApiError(403, problem({ detail: 'Something else' }))),
    ).toBe('/login');
    expect(recoveryRouteFor(new ApiError(403, problem()))).toBe('/login');
    expect(recoveryRouteFor(new ApiError(403, null))).toBe('/login');
  });

  it('leaves 401 to the query client, which owns session loss', () => {
    expect(recoveryRouteFor(new ApiError(401, problem()))).toBeNull();
  });

  it('leaves transport failures and 5xx alone so they stay diagnosable', () => {
    expect(recoveryRouteFor(new ApiError(500, problem()))).toBeNull();
    expect(recoveryRouteFor(new TypeError('Failed to fetch'))).toBeNull();
  });
});
