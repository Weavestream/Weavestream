import {
  MFA_CHALLENGE_REQUIRED_CODE,
  MFA_ENROLLMENT_REQUIRED_CODE,
  STEP_UP_REQUIRED_CODE,
} from '@weavestream/shared';
import { ApiError } from './api';

export type Recovery = '/app' | '/login' | '/mfa/challenge' | '/mfa/setup';

/**
 * Where to send someone whose session exists but cannot reach protected
 * resources.
 *
 * `MfaEnrollmentGuard` 403s a *partially authenticated* session in two
 * distinct states, and `/auth/me` is not exempt from it:
 *
 *   - never enrolled (`mfaEnforcementCompletedAt === null`)
 *   - enrolled, but this session has not passed its challenge
 *     (`mfaPending`)
 *
 * Both are recoverable, and neither is "you don't have access". A cold
 * PWA launch straight to `/m/app` carries no memory of how it got there,
 * so without this the user hits a dead end with only a Retry button that
 * will never succeed.
 *
 * Discrimination is by the **stable problem code** the guard emits as an
 * RFC-7807 extension member. An earlier version matched the guard's
 * human-readable message instead, which coupled recovery to server
 * wording — rewording the sentence would have silently reintroduced the
 * dead end. The prose match survives only as a fallback for an API
 * predating the codes, and unrecognised 403s that are not identifiably
 * an authorization denial fall through to `/login`, which re-derives the
 * state authoritatively from the login response.
 */
export function recoveryRouteFor(error: unknown): Recovery | null {
  if (!(error instanceof ApiError)) return null;

  // 401 is handled globally by the query client — session gone, not partial.
  if (error.status !== 403) return null;

  const { code, detail } = problemFields(error.problem);

  // Preferred path: a stable identifier.
  if (code === MFA_ENROLLMENT_REQUIRED_CODE) return '/mfa/setup';
  if (code === MFA_CHALLENGE_REQUIRED_CODE) return '/mfa/challenge';

  // A genuine authorization denial must NOT become a login bounce — that
  // would hide the real fault behind a credential prompt that appears to
  // succeed. Step-up is likewise not session loss; it has its own prompt.
  if (code === STEP_UP_REQUIRED_CODE) return null;
  if (code) return null;

  // Compatibility fallback for a server that predates the codes.
  // Deliberately loose: matches "enroll", "enrol", "enrollment".
  if (/enroll?/i.test(detail)) return '/mfa/setup';
  if (/challenge/i.test(detail)) return '/mfa/challenge';

  // Unrecognised 403 with no code at all. We cannot distinguish a
  // partial-MFA session from an RBAC denial, and stranding someone on a
  // terminal screen is the worse failure — login re-derives the truth and
  // costs one extra step. This is the documented default, and it applies
  // whether or not `detail` was present.
  return '/login';
}

function problemFields(problem: unknown): { code: string; detail: string } {
  if (typeof problem !== 'object' || problem === null) {
    return { code: '', detail: '' };
  }
  const p = problem as Record<string, unknown>;
  const detail = p.detail ?? p.title ?? p.message;
  return {
    code: typeof p.code === 'string' ? p.code : '',
    detail: typeof detail === 'string' ? detail : '',
  };
}
