import { z } from 'zod';

/**
 * Public single sign-on (OIDC) configuration, as `GET /auth/sso/config`
 * returns it to the unauthenticated login page. Deliberately minimal: no
 * issuer, client id, tenant or secret ever leaves the server.
 */
export const ssoConfigSchema = z.object({
  enabled: z.boolean(),
  /** Button label: "Sign in with <providerName>". */
  providerName: z.string(),
  /** False when password login is refused for everyone but SUPER_ADMIN. */
  localLoginEnabled: z.boolean(),
});
export type SsoConfig = z.infer<typeof ssoConfigSchema>;

/**
 * The fixed set of `?sso_error=` codes the callback redirects to
 * `/login` with. Short and generic on purpose: the detail stays in the server
 * log and the audit trail, never in a URL.
 */
export const SSO_ERROR_CODES = ['no_account', 'not_allowed', 'failed', 'expired'] as const;
export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];

export function isSsoErrorCode(value: unknown): value is SsoErrorCode {
  return typeof value === 'string' && (SSO_ERROR_CODES as readonly string[]).includes(value);
}
