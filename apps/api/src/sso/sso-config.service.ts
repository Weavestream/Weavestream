import { Injectable } from '@nestjs/common';
import { EnvService } from '../config/env.service.js';

/** Where the identity provider returns the browser, under `API_URL`. */
export const SSO_CALLBACK_PATH = '/v1/auth/sso/callback';

/** Where the configuration came from. Only the environment today. */
export type SsoConfigSource = 'env';

/**
 * The effective single sign-on configuration. `enabled` means "usable":
 * issuer, client id and client secret are all present.
 */
export interface SsoResolvedConfig {
  source: SsoConfigSource;
  enabled: boolean;
  providerName: string;
  issuer: string | null;
  clientId: string | null;
  clientSecret: string | null;
  scopes: string;
  allowedTenantId: string | undefined;
  linkByEmail: boolean;
  autoProvision: boolean;
  trustIdpMfa: boolean;
  localLoginEnabled: boolean;
}

/**
 * The ONE place single sign-on configuration is read: the `SSO_*` environment
 * variables (validated at startup by `loadEnv`). Auth code and the SSO feature
 * both go through it, so there is a single seam to extend.
 */
@Injectable()
export class SsoConfigService {
  constructor(private readonly env: EnvService) {}

  /** The redirect URI to register at the identity provider. */
  callbackUrl(): string {
    return `${this.env.values.API_URL.replace(/\/+$/, '')}${SSO_CALLBACK_PATH}`;
  }

  async get(): Promise<SsoResolvedConfig> {
    const v = this.env.values;
    return {
      source: 'env',
      enabled: !!(v.SSO_OIDC_ISSUER && v.SSO_OIDC_CLIENT_ID && v.SSO_OIDC_CLIENT_SECRET),
      providerName: v.SSO_PROVIDER_NAME,
      issuer: v.SSO_OIDC_ISSUER ?? null,
      clientId: v.SSO_OIDC_CLIENT_ID ?? null,
      clientSecret: v.SSO_OIDC_CLIENT_SECRET ?? null,
      scopes: v.SSO_OIDC_SCOPES,
      allowedTenantId: v.SSO_ALLOWED_TENANT_ID,
      linkByEmail: v.SSO_LINK_BY_EMAIL,
      autoProvision: v.SSO_AUTO_PROVISION,
      trustIdpMfa: v.SSO_TRUST_IDP_MFA,
      localLoginEnabled: v.SSO_LOCAL_LOGIN,
    };
  }
}
