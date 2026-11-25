import type { EnvService } from '../config/env.service.js';
import { SsoConfigService } from './sso-config.service.js';

const ISSUER = 'https://login.example.test/tenant-1/v2.0';

function make(env: Record<string, unknown> = {}) {
  return new SsoConfigService({
    values: {
      API_URL: 'https://wiki.example.test/api/',
      SSO_PROVIDER_NAME: 'Example IdP',
      SSO_OIDC_SCOPES: 'openid',
      SSO_LINK_BY_EMAIL: false,
      SSO_AUTO_PROVISION: false,
      SSO_TRUST_IDP_MFA: false,
      SSO_LOCAL_LOGIN: true,
      ...env,
    },
  } as unknown as EnvService);
}

describe('SsoConfigService', () => {
  it('is off when nothing is configured', async () => {
    expect(await make().get()).toMatchObject({
      source: 'env',
      enabled: false,
      issuer: null,
      clientId: null,
      clientSecret: null,
      localLoginEnabled: true,
    });
  });

  it('reads every value from the environment', async () => {
    const c = await make({
      SSO_OIDC_ISSUER: ISSUER,
      SSO_OIDC_CLIENT_ID: 'client-1',
      SSO_OIDC_CLIENT_SECRET: 'placeholder-secret',
      SSO_ALLOWED_TENANT_ID: '99999999-2222-3333-4444-555555555555',
      SSO_LINK_BY_EMAIL: true,
      SSO_AUTO_PROVISION: true,
      SSO_TRUST_IDP_MFA: true,
      SSO_LOCAL_LOGIN: false,
    }).get();
    expect(c).toMatchObject({
      source: 'env',
      enabled: true,
      providerName: 'Example IdP',
      issuer: ISSUER,
      clientId: 'client-1',
      clientSecret: 'placeholder-secret',
      scopes: 'openid',
      allowedTenantId: '99999999-2222-3333-4444-555555555555',
      linkByEmail: true,
      autoProvision: true,
      trustIdpMfa: true,
      localLoginEnabled: false,
    });
  });

  it.each([
    ['no issuer', { SSO_OIDC_CLIENT_ID: 'c', SSO_OIDC_CLIENT_SECRET: 's' }],
    ['no client id', { SSO_OIDC_ISSUER: ISSUER, SSO_OIDC_CLIENT_SECRET: 's' }],
    ['no client secret', { SSO_OIDC_ISSUER: ISSUER, SSO_OIDC_CLIENT_ID: 'c' }],
  ])('is not usable with %s', async (_name, env) => {
    expect((await make(env).get()).enabled).toBe(false);
  });

  it('builds the callback URL from API_URL without doubling the slash', () => {
    expect(make().callbackUrl()).toBe('https://wiki.example.test/api/v1/auth/sso/callback');
  });
});
