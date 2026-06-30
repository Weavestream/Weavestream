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
