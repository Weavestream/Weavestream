import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EnvService } from '../config/env.service.js';
import {
  IntegrationSecretEncryptionService,
  SSO_SETTINGS_CLIENT_SECRET_AAD,
} from '../crypto/integration-secret-encryption.service.js';

/** Where the identity provider returns the browser, under `API_URL`. */
export const SSO_CALLBACK_PATH = '/v1/auth/sso/callback';

export const SSO_SETTINGS_SINGLETON_ID = 'singleton';

/** Every `SSO_*` variable that can configure single sign-on. */
export const SSO_ENV_KEYS = [
  'SSO_OIDC_ISSUER',
  'SSO_OIDC_CLIENT_ID',
  'SSO_OIDC_CLIENT_SECRET',
  'SSO_OIDC_SCOPES',
  'SSO_PROVIDER_NAME',
  'SSO_LINK_BY_EMAIL',
  'SSO_AUTO_PROVISION',
  'SSO_TRUST_IDP_MFA',
  'SSO_ASSUME_IDP_MFA',
  'SSO_LOCAL_LOGIN',
  'SSO_ALLOWED_TENANT_ID',
] as const;

export type SsoConfigSource = 'env' | 'database';

/**
 * The effective single sign-on configuration, whichever source it came from.
 * `enabled` means "usable": switched on AND issuer, client id and a readable
 * client secret are all present.
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
  /** Already ANDed with `trustIdpMfa`: true only when both are on. */
  assumeIdpMfa: boolean;
  /** Always true while SSO is off: password login can only be refused when SSO can replace it. */
  localLoginEnabled: boolean;
}

export type SsoSettingRow = {
  enabled: boolean;
  providerName: string;
  issuer: string | null;
  clientId: string | null;
  clientSecretCiphertext: string | null;
  scopes: string;
  allowedTenantId: string | null;
  linkByEmail: boolean;
  autoProvision: boolean;
  trustIdpMfa: boolean;
  assumeIdpMfa: boolean;
  localLoginEnabled: boolean;
  updatedAt: Date;
  updatedBy: string | null;
};

/** What an install with no saved row gets: SSO off, everything else at the shipped default. */
export const SSO_SETTING_DEFAULTS = {
  enabled: false,
  providerName: 'Single sign-on',
  issuer: null,
  clientId: null,
  clientSecretCiphertext: null,
  scopes: 'openid profile email',
  allowedTenantId: null,
  linkByEmail: false,
  autoProvision: false,
  trustIdpMfa: false,
  assumeIdpMfa: false,
  localLoginEnabled: true,
  updatedAt: null,
  updatedBy: null,
} as const;

/**
 * The ONE place single sign-on configuration is read. Precedence:
 *
 *  1. `SSO_OIDC_ISSUER` set in the environment: the environment wins ENTIRELY
 *     (every `SSO_*` value comes from it, the database row is ignored and the
 *     admin UI is read-only). An env-configured install behaves exactly as
 *     before this service existed.
 *  2. Otherwise the `SsoSetting` row (Admin > Settings > Single sign-on).
 *
 * The database path is cached for a few seconds (`get()` runs on every
 * authenticated request) and `invalidate()` is called on every save, so a
 * change applies at once on this instance and within the TTL on others.
 */
@Injectable()
export class SsoConfigService {
  static readonly CACHE_TTL_MS = 5_000;
  private readonly logger = new Logger(SsoConfigService.name);
  private cache: { value: SsoResolvedConfig; expiresAt: number } | null = null;

  constructor(
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
    private readonly crypto: IntegrationSecretEncryptionService,
  ) {}

  /** True when the environment configures SSO (the UI is then read-only). */
  get envManaged(): boolean {
    return !!this.env.values.SSO_OIDC_ISSUER;
  }

  /** Names (never values) of the `SSO_*` variables present in the environment. */
  envKeysSet(): string[] {
    return SSO_ENV_KEYS.filter((k) => (process.env[k] ?? '').trim() !== '');
  }

  /** The redirect URI to register at the identity provider. */
  callbackUrl(): string {
    return `${this.env.values.API_URL.replace(/\/+$/, '')}${SSO_CALLBACK_PATH}`;
  }

  async get(): Promise<SsoResolvedConfig> {
    if (this.envManaged) return this.fromEnv();
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;
    const row = await this.prisma.ssoSetting.findUnique({
      where: { id: SSO_SETTINGS_SINGLETON_ID },
    });
    const value = this.fromRow(row);
    this.cache = { value, expiresAt: now + SsoConfigService.CACHE_TTL_MS };
    return value;
  }

  /** Drop the cached database configuration. Called after every save. */
  invalidate(): void {
    this.cache = null;
  }

  /** Decrypt a stored client secret; null when absent or unreadable. */
  decryptSecret(ciphertext: string | null): string | null {
    if (!ciphertext) return null;
    try {
      return this.crypto.decrypt(ciphertext, SSO_SETTINGS_CLIENT_SECRET_AAD);
    } catch {
      // Key rotated without re-saving, or a tampered row: SSO stays off until
      // an admin saves the secret again. Logged, never surfaced to a client.
      this.logger.warn('The stored SSO client secret could not be decrypted; SSO is unavailable');
      return null;
    }
  }

  private fromEnv(): SsoResolvedConfig {
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
      assumeIdpMfa: v.SSO_TRUST_IDP_MFA && v.SSO_ASSUME_IDP_MFA,
      localLoginEnabled: v.SSO_LOCAL_LOGIN,
    };
  }

  private fromRow(row: SsoSettingRow | null): SsoResolvedConfig {
    const r = row ?? { ...SSO_SETTING_DEFAULTS };
    const clientSecret = this.decryptSecret(r.clientSecretCiphertext);
    const enabled = !!(r.enabled && r.issuer && r.clientId && clientSecret);
    return {
      source: 'database',
      enabled,
      providerName: r.providerName,
      issuer: r.issuer,
      clientId: r.clientId,
      clientSecret,
      scopes: r.scopes,
      allowedTenantId: r.allowedTenantId ?? undefined,
      linkByEmail: r.linkByEmail,
      autoProvision: r.autoProvision,
      trustIdpMfa: r.trustIdpMfa,
      assumeIdpMfa: r.trustIdpMfa && r.assumeIdpMfa,
      localLoginEnabled: enabled ? r.localLoginEnabled : true,
    };
  }
}
