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

// ---------------------------------------------------------------------------
// Admin > Settings > Single sign-on (`/settings/sso`).
// ---------------------------------------------------------------------------

/** Where the effective configuration comes from. `env` wins entirely. */
export const ssoSettingsSourceSchema = z.enum(['env', 'database']);
export type SsoSettingsSource = z.infer<typeof ssoSettingsSourceSchema>;

/** `GET /settings/sso`. The client secret is never part of this. */
export const ssoSettingsSchema = z.object({
  source: ssoSettingsSourceSchema,
  /** Names (never values) of the `SSO_*` variables set in the environment. */
  envKeysSet: z.array(z.string()),
  enabled: z.boolean(),
  providerName: z.string(),
  issuer: z.string().nullable(),
  clientId: z.string().nullable(),
  /** Whether a client secret is stored/configured. The secret itself never leaves the server. */
  clientSecretSet: z.boolean(),
  scopes: z.string(),
  allowedTenantId: z.string().nullable(),
  linkByEmail: z.boolean(),
  autoProvision: z.boolean(),
  trustIdpMfa: z.boolean(),
  assumeIdpMfa: z.boolean(),
  localLoginEnabled: z.boolean(),
  /** The redirect URI to register at the identity provider. */
  callbackUrl: z.string(),
  updatedAt: z.string().nullable(),
});
export type SsoSettings = z.infer<typeof ssoSettingsSchema>;

const ssoTrimmed = (max: number, label: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().max(max, `${label} must be at most ${max} characters`));

/** An optional text field: empty text means "not set". */
const ssoNullableText = (max: number, label: string) =>
  z.union([ssoTrimmed(max, label).transform((v) => (v === '' ? null : v)), z.null()]);

export const updateSsoSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    providerName: ssoTrimmed(60, 'Provider name')
      .pipe(z.string().min(1, 'Provider name is required'))
      .optional(),
    issuer: ssoNullableText(2048, 'Issuer URL').optional(),
    clientId: ssoNullableText(255, 'Client ID').optional(),
    /** Omit to keep the stored secret; send `clearClientSecret` to remove it. */
    clientSecret: z.string().min(1, 'Client secret is required').max(1024, 'Client secret is too long').optional(),
    clearClientSecret: z.boolean().optional(),
    scopes: ssoTrimmed(500, 'Scopes').pipe(z.string().min(1, 'Scopes are required')).optional(),
    allowedTenantId: ssoNullableText(64, 'Allowed tenant ID').optional(),
    linkByEmail: z.boolean().optional(),
    autoProvision: z.boolean().optional(),
    trustIdpMfa: z.boolean().optional(),
    assumeIdpMfa: z.boolean().optional(),
    localLoginEnabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided')
  .refine((v) => !(v.assumeIdpMfa === true && v.trustIdpMfa === false), {
    message: 'Assuming provider MFA requires trusting the provider multi-factor sign-in',
    path: ['assumeIdpMfa'],
  })
  .refine((v) => !(v.clientSecret && v.clearClientSecret), {
    message: 'Cannot set and clear the client secret in the same request',
    path: ['clientSecret'],
  });
export type UpdateSsoSettingsInput = z.infer<typeof updateSsoSettingsSchema>;

/** `POST /settings/sso/test`: optionally try an issuer that is not saved yet. */
export const testSsoSettingsSchema = z.object({
  issuer: ssoTrimmed(2048, 'Issuer URL').optional(),
});
export type TestSsoSettingsInput = z.infer<typeof testSsoSettingsSchema>;

export const ssoTestResultSchema = z.object({
  ok: z.boolean(),
  issuer: z.string(),
  /** Shown, not checked: whether it is registered at the provider cannot be tested from here. */
  callbackUrl: z.string(),
  discoveryReachable: z.boolean(),
  issuerMatches: z.boolean().nullable(),
  authorizationEndpoint: z.string().nullable(),
  tokenEndpoint: z.string().nullable(),
  jwksUri: z.string().nullable(),
  jwksReachable: z.boolean().nullable(),
  /** Plain-language outcome. Fixed wording, never a provider response body. */
  message: z.string(),
});
export type SsoTestResult = z.infer<typeof ssoTestResultSchema>;
