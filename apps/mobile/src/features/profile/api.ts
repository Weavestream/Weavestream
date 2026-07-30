import type { ChangePasswordInput } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';

/**
 * Account mutations.
 *
 * **This one call deliberately does NOT go through TanStack Query, and that
 * is not an oversight to tidy up.** `lib/query-client.ts` routes any 401 in
 * the mutation cache straight to `redirectToLogin()`, which is right for
 * every ordinary resource — a 401 there means the session is gone. But
 * `POST /me/change-password` also 401s when the *supplied current password*
 * is wrong, so running it through a mutation would sign a technician out
 * over a typo. The caller owns the 401 branch instead, discriminating on
 * `CURRENT_PASSWORD_INVALID_CODE`; see `ChangePasswordScreen`.
 *
 * Passwords are sent verbatim — never trimmed. Leading or trailing
 * whitespace is part of the secret (`StepUpHost` records the same rule:
 * trim an MFA code, send a password as typed).
 */
export async function changeMyPassword(input: ChangePasswordInput): Promise<void> {
  await apiFetch<{ ok: true }>('/me/change-password', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
