/**
 * The ONE set of validation rules for OIDC single sign-on configuration.
 *
 * It is used by the environment loader (`SSO_*` variables, in `env.ts`). Pure
 * and isomorphic (no Node APIs).
 */

/**
 * Issuer URLs that identify a *multi-tenant* Entra endpoint. Any tenant's
 * users can sign in there, and email addresses are attacker-controlled
 * across tenants, so linking by email would be an account takeover. Refused
 * at startup / on save rather than relying on link-by-email being off.
 */
// 9188040d-... is the well-known tenant id of Microsoft personal accounts
// (the "consumers" tenant), which is as multi-tenant as /consumers itself.
const MULTI_TENANT_ISSUER_SEGMENT =
  /\/(common|organizations|consumers|9188040d-6c67-4c5b-b112-36a304b66dad)(\/|$)/i;

export function isMultiTenantIssuer(issuer: string): boolean {
  return MULTI_TENANT_ISSUER_SEGMENT.test(issuer);
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** An Entra tenant id: a GUID. */
export const ENTRA_TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isEntraTenantId(value: string): boolean {
  return ENTRA_TENANT_ID_PATTERN.test(value);
}

/** Microsoft Entra issuer for a tenant id (what the setup helper fills in). */
export function entraIssuerForTenant(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId.trim()}/v2.0`;
}

export type SsoSettingsField = 'issuer' | 'clientId' | 'clientSecret' | 'allowedTenantId';

export interface SsoSettingsProblem {
  field: SsoSettingsField;
  /** Stable code, for callers that word the message themselves. */
  code:
    | 'issuer_invalid_url'
    | 'issuer_not_https'
    | 'issuer_multi_tenant'
    | 'client_id_required'
    | 'client_secret_required'
    | 'tenant_id_invalid';
  message: string;
}

export interface SsoSettingsCandidate {
  issuer?: string | null;
  clientId?: string | null;
  /** True when a secret is available (supplied now, or already stored). */
  clientSecretPresent: boolean;
  allowedTenantId?: string | null;
}

/**
 * Cross-field validation for an SSO configuration that is (about to be)
 * ACTIVE. Returns one problem per issue; empty when valid. The caller decides
 * when it applies (env: issuer set; settings: `enabled`).
 */
export function validateSsoSettings(input: SsoSettingsCandidate): SsoSettingsProblem[] {
  const problems: SsoSettingsProblem[] = [];
  const issuer = input.issuer?.trim();

  if (!issuer) {
    problems.push({ field: 'issuer', code: 'issuer_invalid_url', message: 'must be an absolute URL' });
  } else {
    let url: URL | null = null;
    try {
      url = new URL(issuer);
    } catch {
      problems.push({
        field: 'issuer',
        code: 'issuer_invalid_url',
        message: 'must be an absolute URL',
      });
    }
    if (url && url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
      problems.push({ field: 'issuer', code: 'issuer_not_https', message: 'must use https' });
    }
    if (isMultiTenantIssuer(issuer)) {
      problems.push({
        field: 'issuer',
        code: 'issuer_multi_tenant',
        message:
          'a multi-tenant endpoint (/common, /organizations or /consumers) is refused; ' +
          'use https://login.microsoftonline.com/<tenant-id>/v2.0',
      });
    }
  }
  if (!input.clientId?.trim()) {
    problems.push({ field: 'clientId', code: 'client_id_required', message: 'is required' });
  }
  if (!input.clientSecretPresent) {
    problems.push({ field: 'clientSecret', code: 'client_secret_required', message: 'is required' });
  }
  const tenant = input.allowedTenantId?.trim();
  if (tenant && !isEntraTenantId(tenant)) {
    problems.push({
      field: 'allowedTenantId',
      code: 'tenant_id_invalid',
      message: 'must be a tenant id in the form 00000000-0000-0000-0000-000000000000',
    });
  }
  return problems;
}
