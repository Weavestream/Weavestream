import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  MFA_CHALLENGE_REQUIRED_CODE,
  MFA_ENROLLMENT_REQUIRED_CODE,
} from '@weavestream/shared';
import { MfaEnrollmentGuard } from './mfa-enrollment.guard.js';

/**
 * The two 403s this guard raises are *recoverable* states, not denials,
 * and a client has to tell them apart to route the user somewhere useful:
 * "never enrolled" needs the setup flow, "not yet verified this session"
 * needs the challenge.
 *
 * They previously differed only by their human-readable message, which
 * forced the mobile client to match on prose — so rewording a sentence
 * here would have silently stranded users on a terminal error screen.
 * These assertions pin the machine-readable contract instead.
 */
function contextFor(
  user: Record<string, unknown> | undefined,
  { method = 'GET', path = '/api/v1/auth/me' } = {},
) {
  const req = { user, method, path };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as never;
}

function guardWith(flags: { isPublic?: boolean; mfaSetupAllowed?: boolean } = {}) {
  const reflector = {
    getAllAndOverride: (key: unknown) =>
      String(key).includes('public') ? flags.isPublic : flags.mfaSetupAllowed,
  } as unknown as Reflector;
  return new MfaEnrollmentGuard(reflector);
}

/** Pull the RFC-7807 extension members off the thrown exception. */
function payloadOf(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (err) {
    if (err instanceof ForbiddenException) {
      return err.getResponse() as Record<string, unknown>;
    }
    throw err;
  }
  throw new Error('expected the guard to throw');
}

describe('MfaEnrollmentGuard problem codes', () => {
  it('tags an unenrolled session with a stable enrollment code', () => {
    const payload = payloadOf(() =>
      guardWith().canActivate(
        contextFor({ mfaEnforcementCompletedAt: null, mfaPending: false }),
      ),
    );
    expect(payload.code).toBe(MFA_ENROLLMENT_REQUIRED_CODE);
    // Exact, not a regex: the code is ADDITIVE. `message` becomes the
    // problem body's `detail`, and any existing consumer still reading
    // that string must see byte-for-byte what it saw before.
    expect(payload.message).toBe('MFA enrollment required');
  });

  it('tags an unverified session with a stable challenge code', () => {
    const payload = payloadOf(() =>
      guardWith().canActivate(
        contextFor({ mfaEnforcementCompletedAt: new Date(), mfaPending: true }),
      ),
    );
    expect(payload.code).toBe(MFA_CHALLENGE_REQUIRED_CODE);
    expect(payload.message).toMatch(/challenge/i);
  });

  it('uses two DIFFERENT codes — the whole point is telling them apart', () => {
    expect(MFA_ENROLLMENT_REQUIRED_CODE).not.toBe(MFA_CHALLENGE_REQUIRED_CODE);
  });

  it('still lets a fully authenticated session through', () => {
    expect(
      guardWith().canActivate(
        contextFor({ mfaEnforcementCompletedAt: new Date(), mfaPending: false }),
      ),
    ).toBe(true);
  });

  it('still exempts MFA-setup routes and logout', () => {
    expect(
      guardWith({ mfaSetupAllowed: true }).canActivate(
        contextFor({ mfaEnforcementCompletedAt: null, mfaPending: false }),
      ),
    ).toBe(true);
    expect(
      guardWith().canActivate(
        contextFor(
          { mfaEnforcementCompletedAt: null, mfaPending: false },
          { method: 'POST', path: '/api/v1/auth/logout' },
        ),
      ),
    ).toBe(true);
  });
});
