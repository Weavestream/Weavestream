import { z } from 'zod';

/**
 * Step-up (re-authentication) verification payload.
 *
 * The single `code` field carries whichever credential the account's
 * required factor expects: a 6-digit TOTP, a 10-char backup code, or
 * the account password. The server decides which to verify from the
 * user's MFA state (see `requiredFactor` in the step-up service), so
 * this schema only bounds length — permissive enough for a long
 * password yet rejecting empty / oversized input.
 *
 * Deliberately NOT reused from `MfaVerifyDto`, whose regex is
 * TOTP/backup-code-only and would reject every password.
 */
export const stepUpVerifySchema = z.object({
  code: z.string().min(1).max(256),
});
export type StepUpVerifyInput = z.infer<typeof stepUpVerifySchema>;

/** Which credential the client must collect for a step-up challenge. */
export type StepUpFactor = 'mfa' | 'password';

/** Shape returned by `GET /auth/step-up` for the proactive download flow. */
export interface StepUpStatus {
  verified: boolean;
  factor: StepUpFactor;
  expiresInSec: number;
}

/**
 * The RFC-7807 `code` the API sets on a 403 when the caller must
 * re-authenticate before the request is allowed through.
 *
 * Lives here rather than in either app because both clients have to
 * recognise the same string: `apps/web`'s `apiFetch` retries once behind
 * a modal, and `apps/mobile` has to distinguish this from an ordinary
 * 403 so it can prompt instead of showing a dead end. A typo in a
 * per-app copy would fail open into a generic error toast.
 */
export const STEP_UP_REQUIRED_CODE = 'step_up_required';

/**
 * Stable problem codes for the two recoverable MFA states.
 *
 * `MfaEnrollmentGuard` 403s a partially-authenticated session in two
 * ways, and a client has to tell them apart to route the user somewhere
 * useful — "not enrolled" needs the setup flow, "not yet verified this
 * session" needs the challenge. Before these existed the only signal was
 * the exception's human-readable message, which meant a client matching
 * on prose: rewording the server string would silently strand users on a
 * terminal error screen.
 *
 * Emitted as RFC-7807 extension members alongside `detail`.
 */
export const MFA_ENROLLMENT_REQUIRED_CODE = 'mfa_enrollment_required';
export const MFA_CHALLENGE_REQUIRED_CODE = 'mfa_challenge_required';

/** Narrows an RFC-7807 problem body to the step-up-required challenge. */
export function isStepUpProblem(
  problem: unknown,
): problem is { code: typeof STEP_UP_REQUIRED_CODE; factor?: StepUpFactor } {
  return (
    typeof problem === 'object' &&
    problem !== null &&
    (problem as { code?: unknown }).code === STEP_UP_REQUIRED_CODE
  );
}
