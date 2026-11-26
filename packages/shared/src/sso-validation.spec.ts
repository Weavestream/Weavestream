import {
  entraIssuerForTenant,
  isEntraTenantId,
  validateSsoSettings,
  type SsoSettingsCandidate,
} from './sso-validation.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const GOOD: SsoSettingsCandidate = {
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  clientId: 'client-id',
  clientSecretPresent: true,
  allowedTenantId: TENANT,
};

const codes = (c: SsoSettingsCandidate) => validateSsoSettings(c).map((p) => p.code);

describe('validateSsoSettings', () => {
  it('accepts a complete single-tenant configuration', () => {
    expect(validateSsoSettings(GOOD)).toEqual([]);
  });

  it('accepts a loopback http issuer (local development) but no other http', () => {
    expect(codes({ ...GOOD, issuer: 'http://localhost:8080/realms/x' })).toEqual([]);
    expect(codes({ ...GOOD, issuer: 'http://idp.example.com' })).toEqual(['issuer_not_https']);
  });

  it.each([
    'https://login.microsoftonline.com/common/v2.0',
    'https://login.microsoftonline.com/organizations/v2.0',
    'https://login.microsoftonline.com/consumers/v2.0',
    'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
  ])('refuses the multi-tenant issuer %s', (issuer) => {
    expect(codes({ ...GOOD, issuer })).toEqual(['issuer_multi_tenant']);
  });

  it('refuses a missing or malformed issuer', () => {
    expect(codes({ ...GOOD, issuer: null })).toEqual(['issuer_invalid_url']);
    expect(codes({ ...GOOD, issuer: 'not a url' })).toEqual(['issuer_invalid_url']);
  });

  it('requires a client id and a client secret', () => {
    expect(codes({ ...GOOD, clientId: '  ', clientSecretPresent: false })).toEqual([
      'client_id_required',
      'client_secret_required',
    ]);
  });

  it('checks the allowed tenant id format, and treats empty as not set', () => {
    expect(codes({ ...GOOD, allowedTenantId: 'contoso' })).toEqual(['tenant_id_invalid']);
    expect(codes({ ...GOOD, allowedTenantId: '' })).toEqual([]);
    expect(codes({ ...GOOD, allowedTenantId: null })).toEqual([]);
  });

  it('names the field each problem belongs to', () => {
    expect(validateSsoSettings({ ...GOOD, clientSecretPresent: false })[0]?.field).toBe(
      'clientSecret',
    );
  });
});

describe('Entra helpers', () => {
  it('builds the v2.0 issuer for a tenant id', () => {
    expect(entraIssuerForTenant(` ${TENANT} `)).toBe(GOOD.issuer);
  });
  it('recognises tenant ids', () => {
    expect(isEntraTenantId(TENANT)).toBe(true);
    expect(isEntraTenantId('common')).toBe(false);
  });
});
