import type { SsoConfigService, SsoResolvedConfig } from './sso-config.service.js';

/**
 * Spec helper: an `SsoConfigService` stand-in whose answers come from the same
 * `SSO_*` keys the specs already use for their env stub, so each spec keeps
 * its existing vocabulary. Not used by production code.
 */
export function fakeSsoConfig(values: Record<string, unknown> = {}): SsoConfigService {
  const v = values as Record<string, string | boolean | undefined>;
  const resolved: SsoResolvedConfig = {
    source: 'env',
    enabled: 'SSO_OIDC_ISSUER' in v ? !!(v.SSO_OIDC_ISSUER && v.SSO_OIDC_CLIENT_ID && v.SSO_OIDC_CLIENT_SECRET) : true,
    providerName: (v.SSO_PROVIDER_NAME as string | undefined) ?? 'Single sign-on',
    issuer: (v.SSO_OIDC_ISSUER as string | undefined) ?? null,
    clientId: (v.SSO_OIDC_CLIENT_ID as string | undefined) ?? null,
    clientSecret: (v.SSO_OIDC_CLIENT_SECRET as string | undefined) ?? null,
    scopes: (v.SSO_OIDC_SCOPES as string | undefined) ?? 'openid profile email',
    allowedTenantId: v.SSO_ALLOWED_TENANT_ID as string | undefined,
    linkByEmail: v.SSO_LINK_BY_EMAIL === true,
    autoProvision: v.SSO_AUTO_PROVISION === true,
    trustIdpMfa: v.SSO_TRUST_IDP_MFA === true,
    localLoginEnabled: v.SSO_LOCAL_LOGIN !== false,
  };
  return {
    get: async () => resolved,
    callbackUrl: () => `${String(v.API_URL ?? 'https://wiki.example.test').replace(/\/+$/, '')}/v1/auth/sso/callback`,
    envManaged: !!v.SSO_OIDC_ISSUER,
  } as unknown as SsoConfigService;
}
