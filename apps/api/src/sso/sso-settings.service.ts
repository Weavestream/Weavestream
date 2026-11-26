import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  validateSsoSettings,
  type SsoSettings,
  type SsoSettingsProblem,
  type SsoTestResult,
  type TestSsoSettingsInput,
  type UpdateSsoSettingsInput,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import {
  IntegrationSecretEncryptionService,
  SSO_SETTINGS_CLIENT_SECRET_AAD,
} from '../crypto/integration-secret-encryption.service.js';
import { EgressBlockedError } from '../common/egress/safe-fetch.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';
import {
  SSO_SETTING_DEFAULTS,
  SSO_SETTINGS_SINGLETON_ID,
  SsoConfigService,
  type SsoSettingRow,
} from './sso-config.service.js';
import { fetcherFor, isAllowedEndpoint, metadataSchema, type SsoFetcher } from './sso-oidc.service.js';

const TEST_TIMEOUT_MS = 10_000;

const PROBLEM_LABEL: Record<SsoSettingsProblem['field'], string> = {
  issuer: 'Issuer URL',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  allowedTenantId: 'Allowed tenant ID',
};

/** The editable, non-secret columns (field names reported in the audit row). */
const TRACKED_FIELDS = [
  'enabled',
  'providerName',
  'issuer',
  'clientId',
  'scopes',
  'allowedTenantId',
  'linkByEmail',
  'autoProvision',
  'trustIdpMfa',
  'localLoginEnabled',
] as const;

type EditableRow = Pick<SsoSettingRow, (typeof TRACKED_FIELDS)[number] | 'clientSecretCiphertext'>;

/**
 * Admin > Settings > Single sign-on. Reads and writes the `SsoSetting` row;
 * when `SSO_OIDC_ISSUER` is set in the environment the environment owns the
 * configuration, `get()` reports it read-only and `update()` refuses.
 */
@Injectable()
export class SsoSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly crypto: IntegrationSecretEncryptionService,
    private readonly config: SsoConfigService,
  ) {}

  async get(): Promise<SsoSettings> {
    const callbackUrl = this.config.callbackUrl();
    if (this.config.envManaged) {
      const c = await this.config.get();
      return {
        source: 'env',
        envKeysSet: this.config.envKeysSet(),
        enabled: c.enabled,
        providerName: c.providerName,
        issuer: c.issuer,
        clientId: c.clientId,
        clientSecretSet: !!c.clientSecret,
        scopes: c.scopes,
        allowedTenantId: c.allowedTenantId ?? null,
        linkByEmail: c.linkByEmail,
        autoProvision: c.autoProvision,
        trustIdpMfa: c.trustIdpMfa,
        localLoginEnabled: c.localLoginEnabled,
        callbackUrl,
        updatedAt: null,
      };
    }
    const row = await this.loadRow();
    return {
      source: 'database',
      envKeysSet: this.config.envKeysSet(),
      enabled: row.enabled,
      providerName: row.providerName,
      issuer: row.issuer,
      clientId: row.clientId,
      clientSecretSet: !!row.clientSecretCiphertext,
      scopes: row.scopes,
      allowedTenantId: row.allowedTenantId,
      linkByEmail: row.linkByEmail,
      autoProvision: row.autoProvision,
      trustIdpMfa: row.trustIdpMfa,
      localLoginEnabled: row.localLoginEnabled,
      callbackUrl,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    };
  }

  async update(
    actor: AuthedUser,
    input: UpdateSsoSettingsInput,
    meta: RequestMeta,
  ): Promise<SsoSettings> {
    if (this.config.envManaged) {
      throw new ConflictException(
        'Single sign-on is managed by environment variables (SSO_OIDC_ISSUER is set). ' +
          'Remove them from the deployment to configure it here.',
      );
    }
    const before = await this.loadRow();
    const next: EditableRow = { ...pick(before) };
    for (const f of TRACKED_FIELDS) {
      const v = input[f];
      if (v !== undefined) (next as Record<string, unknown>)[f] = v;
    }
    const secretAction: 'set' | 'cleared' | 'unchanged' = input.clearClientSecret
      ? 'cleared'
      : input.clientSecret !== undefined
        ? 'set'
        : 'unchanged';
    if (secretAction === 'cleared') next.clientSecretCiphertext = null;
    if (secretAction === 'set') {
      next.clientSecretCiphertext = this.crypto.encrypt(
        input.clientSecret as string,
        SSO_SETTINGS_CLIENT_SECRET_AAD,
      );
    }

    this.assertValid(next);
    if (next.enabled && next.localLoginEnabled === false) {
      await this.assertSuperAdminCanStillSignIn(next.issuer as string);
    }

    const changedFields: string[] = TRACKED_FIELDS.filter((f) => next[f] !== before[f]);
    if (secretAction !== 'unchanged') changedFields.push('clientSecret');

    await this.prisma.ssoSetting.upsert({
      where: { id: SSO_SETTINGS_SINGLETON_ID },
      create: { id: SSO_SETTINGS_SINGLETON_ID, ...next, updatedBy: actor.id },
      update: { ...next, updatedBy: actor.id },
    });
    // Before the audit write: even if it fails the new config is live, so the
    // cache must not keep serving the old one.
    this.config.invalidate();

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.settings.ssoChange,
      entityType: 'SsoSetting',
      entityId: SSO_SETTINGS_SINGLETON_ID,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      // Field NAMES only. Never a value, and the secret only as an outcome word.
      after: { changedFields, clientSecret: secretAction },
    });
    return this.get();
  }

  /**
   * Discovery against the saved or supplied issuer: does it answer, does the
   * document name the same issuer, are the endpoints https, is the key set
   * reachable. Failures are results (ok: false), not exceptions, so the form
   * can show them. Whether the callback URL is registered at the provider
   * cannot be checked from here, so it is only returned.
   */
  async test(
    actor: AuthedUser,
    meta: RequestMeta,
    input: TestSsoSettingsInput,
  ): Promise<SsoTestResult> {
    const callbackUrl = this.config.callbackUrl();
    const envManaged = this.config.envManaged;
    if (envManaged && input.issuer) {
      throw new BadRequestException(
        'Single sign-on is managed by environment variables; the saved issuer is tested.',
      );
    }
    const saved = await this.config.get();
    const issuer = (input.issuer ?? saved.issuer ?? '').trim();
    if (!issuer) {
      throw new BadRequestException('Enter an issuer URL to test.');
    }
    const problems = validateSsoSettings({
      issuer,
      clientId: 'x',
      clientSecretPresent: true,
    }).filter((p) => p.field === 'issuer');
    if (problems.length) throw new BadRequestException(describeProblems(problems));

    // An admin-typed issuer is an SSRF input (guarded); an env issuer is not.
    const fetcher = fetcherFor(envManaged ? 'env' : 'database');
    const result = await this.probe(fetcher, issuer, callbackUrl);

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.settings.ssoTest,
      entityType: 'SsoSetting',
      entityId: SSO_SETTINGS_SINGLETON_ID,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        issuerHost: hostOf(issuer),
        ok: result.ok,
        discoveryReachable: result.discoveryReachable,
        issuerMatches: result.issuerMatches,
        jwksReachable: result.jwksReachable,
        overrideUsed: !!input.issuer,
      },
    });
    return result;
  }

  private async probe(fetcher: SsoFetcher, issuer: string, callbackUrl: string): Promise<SsoTestResult> {
    const base: SsoTestResult = {
      ok: false,
      issuer,
      callbackUrl,
      discoveryReachable: false,
      issuerMatches: null,
      authorizationEndpoint: null,
      tokenEndpoint: null,
      jwksUri: null,
      jwksReachable: null,
      message: '',
    };
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    let doc: unknown;
    try {
      const res = await fetcher(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ...base, message: `The issuer answered HTTP ${res.status} for its discovery document. Check the issuer URL.` };
      }
      doc = await res.json();
    } catch (err) {
      return { ...base, message: unreachableMessage(err) };
    }
    const parsed = metadataSchema.safeParse(doc);
    if (!parsed.success) {
      return {
        ...base,
        discoveryReachable: true,
        message: 'The address answered but did not return an OpenID Connect discovery document.',
      };
    }
    const meta = parsed.data;
    const found = {
      ...base,
      discoveryReachable: true,
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      jwksUri: meta.jwks_uri,
    };
    if (meta.issuer !== issuer) {
      return {
        ...found,
        issuerMatches: false,
        message:
          'The discovery document names a different issuer than the one entered. ' +
          'The issuer must match exactly, including the /v2.0 ending for Microsoft Entra.',
      };
    }
    if (![meta.authorization_endpoint, meta.token_endpoint, meta.jwks_uri].every((u) => isAllowedEndpoint(u, issuer))) {
      return { ...found, issuerMatches: true, message: 'The provider advertises an endpoint that is not https.' };
    }
    let jwksReachable = false;
    try {
      const res = await fetcher(meta.jwks_uri, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      const body = res.ok ? ((await res.json()) as { keys?: unknown }) : null;
      jwksReachable = !!body && Array.isArray(body.keys) && body.keys.length > 0;
    } catch {
      // Reported through `jwksReachable: false` and the message below.
      jwksReachable = false;
    }
    if (!jwksReachable) {
      return { ...found, issuerMatches: true, jwksReachable: false, message: 'Discovery worked, but the provider signing keys could not be fetched.' };
    }
    return {
      ...found,
      ok: true,
      issuerMatches: true,
      jwksReachable: true,
      message:
        'Connected. The provider answered and its issuer matches. ' +
        'Make sure the callback URL below is registered as a redirect URI at the provider.',
    };
  }

  private assertValid(next: EditableRow): void {
    let problems = validateSsoSettings({
      issuer: next.issuer,
      clientId: next.clientId,
      clientSecretPresent: !!next.clientSecretCiphertext,
      allowedTenantId: next.allowedTenantId,
    });
    if (!next.enabled) {
      // A draft may be incomplete; what IS filled in must still be valid.
      problems = problems.filter(
        (p) =>
          p.code !== 'client_id_required' &&
          p.code !== 'client_secret_required' &&
          !(p.code === 'issuer_invalid_url' && !next.issuer),
      );
    }
    if (problems.length) throw new BadRequestException(describeProblems(problems));
  }

  /**
   * Refuse turning local login off unless a break-glass way in exists: an
   * active SUPER_ADMIN already linked at this issuer, who can therefore
   * still sign in once password login is refused for everyone else.
   */
  private async assertSuperAdminCanStillSignIn(issuer: string): Promise<void> {
    const count = await this.prisma.userIdentity.count({
      where: { issuer, user: { role: 'SUPER_ADMIN', isActive: true } },
    });
    if (count === 0) {
      throw new ConflictException(
        'Local login cannot be turned off yet: no active super admin has linked their account to this ' +
          'identity provider. Sign in with single sign-on as a super admin first (My account > link), then try again.',
      );
    }
  }

  private async loadRow(): Promise<EditableRow & { updatedAt: Date | null }> {
    const row = await this.prisma.ssoSetting.findUnique({ where: { id: SSO_SETTINGS_SINGLETON_ID } });
    return row ?? { ...SSO_SETTING_DEFAULTS };
  }
}

function pick(row: EditableRow): EditableRow {
  const out: Record<string, unknown> = { clientSecretCiphertext: row.clientSecretCiphertext };
  for (const f of TRACKED_FIELDS) out[f] = row[f];
  return out as EditableRow;
}

function describeProblems(problems: SsoSettingsProblem[]): string {
  return problems.map((p) => `${PROBLEM_LABEL[p.field]} ${p.message}`).join('; ');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

function unreachableMessage(err: unknown): string {
  if (err instanceof EgressBlockedError) {
    return 'That address is not allowed: private, loopback and link-local network addresses are refused.';
  }
  return 'Could not reach the issuer. Check the URL and that the server can make outbound HTTPS requests.';
}
