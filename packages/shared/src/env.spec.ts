import {
  envSchema,
  isForbiddenUploadMime,
  isMultiTenantIssuer,
  loadEnv,
  ssoEnvProblems,
} from './env.js';

// ALLOWED_UPLOAD_MIME must hard-reject browser-active content types at
// boot regardless of operator configuration — the inline-serving safety
// gates elsewhere must never be the only thing standing between an
// operator-extended allowlist and stored XSS.
const field = envSchema.shape.ALLOWED_UPLOAD_MIME;

describe('ALLOWED_UPLOAD_MIME', () => {
  it('accepts the built-in default list', () => {
    expect(field.safeParse(undefined).success).toBe(true);
  });

  it('keeps the default list in sync with the web client mirror', () => {
    // These three were advertised and preflighted by the web client
    // (CLIENT_ALLOWED_MIMES in apps/web/src/lib/upload-client.ts) but
    // missing from the server default, so uploads passed preflight and
    // then died at init with MimeNotAllowed.
    const parsed = field.safeParse(undefined);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const mimes = (parsed.data as string).split(',');
      expect(mimes).toContain('message/rfc822');
      expect(mimes).toContain('image/heif');
      expect(mimes).toContain('image/jpg');
    }
  });

  it('accepts a benign operator-supplied list', () => {
    expect(field.safeParse('image/png,application/pdf,text/csv').success).toBe(true);
  });

  it.each(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'image/foo+xml'])(
    'rejects browser-active type %s even when mixed with benign types',
    (mime) => {
      const result = field.safeParse(`image/png,${mime},application/pdf`);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(mime);
      }
    },
  );

  it('rejects forbidden types regardless of case and whitespace', () => {
    expect(field.safeParse('image/png, Image/SVG+XML ').success).toBe(false);
    expect(field.safeParse('TEXT/HTML').success).toBe(false);
  });

  it('does not reject the non-image XML types on the default list', () => {
    // application/xml and text/xml are force-downloaded, not image/*+xml —
    // they stay legal.
    expect(field.safeParse('application/xml,text/xml,application/json').success).toBe(true);
  });
});

describe('isForbiddenUploadMime', () => {
  it.each([
    ['text/html', true],
    ['application/xhtml+xml', true],
    ['image/svg+xml', true],
    ['image/anything+xml', true],
    [' IMAGE/SVG+XML ', true],
    ['image/png', false],
    ['text/plain', false],
    ['application/xml', false],
    ['text/xml', false],
    ['application/pdf', false],
  ])('%s → %s', (mime, forbidden) => {
    expect(isForbiddenUploadMime(mime)).toBe(forbidden);
  });
});

// Minimal valid environment (every required key). The values are throwaway
// test fixtures, not credentials.
const key = Buffer.alloc(32, 7).toString('base64');
const BASE_ENV: NodeJS.ProcessEnv = {
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:3000/api',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
  REDIS_URL: 'redis://localhost:6379/0',
  JWT_SIGNING_KEY: key,
  MFA_ENCRYPTION_KEY: key,
  COOKIE_SIGNING_KEY: key,
  CSRF_SIGNING_KEY: key,
  PASSWORD_ENCRYPTION_KEY: key,
  INTEGRATION_SECRET_KEY: key,
  SMTP_SECRET_KEY: key,
};
const ENTRA_ISSUER = 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0';
const COMPLETE = { SSO_OIDC_CLIENT_ID: 'client-id', SSO_OIDC_CLIENT_SECRET: 'placeholder-secret' };

describe('single sign-on env', () => {
  it('is off with safe defaults when nothing is set', () => {
    const env = loadEnv(BASE_ENV);
    expect(env.SSO_OIDC_ISSUER).toBeUndefined();
    expect(env.SSO_OIDC_SCOPES).toBe('openid profile email');
    expect(env.SSO_PROVIDER_NAME).toBe('Single sign-on');
    expect(env.SSO_LINK_BY_EMAIL).toBe(false);
    expect(env.SSO_AUTO_PROVISION).toBe(false);
    expect(env.SSO_TRUST_IDP_MFA).toBe(false);
    expect(env.SSO_ASSUME_IDP_MFA).toBe(false);
    expect(env.SSO_LOCAL_LOGIN).toBe(true);
    expect(env.SSO_ALLOWED_TENANT_ID).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    const env = loadEnv({
      ...BASE_ENV,
      SSO_OIDC_ISSUER: '',
      SSO_OIDC_CLIENT_ID: '  ',
      SSO_ALLOWED_TENANT_ID: '',
    });
    expect(env.SSO_OIDC_ISSUER).toBeUndefined();
    expect(env.SSO_OIDC_CLIENT_ID).toBeUndefined();
    expect(env.SSO_ALLOWED_TENANT_ID).toBeUndefined();
  });

  it('accepts a complete single-tenant configuration and parses the booleans', () => {
    const env = loadEnv({
      ...BASE_ENV,
      ...COMPLETE,
      SSO_OIDC_ISSUER: ENTRA_ISSUER,
      SSO_LINK_BY_EMAIL: 'true',
      SSO_AUTO_PROVISION: 'true',
      SSO_TRUST_IDP_MFA: '1',
      SSO_ASSUME_IDP_MFA: 'yes',
      SSO_LOCAL_LOGIN: 'off',
    });
    expect(env.SSO_OIDC_ISSUER).toBe(ENTRA_ISSUER);
    expect(env.SSO_LINK_BY_EMAIL).toBe(true);
    expect(env.SSO_AUTO_PROVISION).toBe(true);
    expect(env.SSO_TRUST_IDP_MFA).toBe(true);
    expect(env.SSO_ASSUME_IDP_MFA).toBe(true);
    expect(env.SSO_LOCAL_LOGIN).toBe(false);
  });

  it('requires a client id and secret once an issuer is set', () => {
    expect(() => loadEnv({ ...BASE_ENV, SSO_OIDC_ISSUER: ENTRA_ISSUER })).toThrow(
      /SSO_OIDC_CLIENT_ID: required[\s\S]*SSO_OIDC_CLIENT_SECRET: required/,
    );
    expect(() =>
      loadEnv({ ...BASE_ENV, SSO_OIDC_ISSUER: ENTRA_ISSUER, SSO_OIDC_CLIENT_ID: 'client-id' }),
    ).toThrow(/SSO_OIDC_CLIENT_SECRET: required/);
  });

  it.each([
    'https://login.microsoftonline.com/common/v2.0',
    'https://login.microsoftonline.com/organizations/v2.0',
    'https://login.microsoftonline.com/consumers/v2.0',
    'https://login.microsoftonline.com/COMMON/v2.0',
    'https://login.microsoftonline.com/common',
    'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
    'https://login.microsoftonline.com/9188040D-6C67-4C5B-B112-36A304B66DAD/v2.0',
  ])('refuses the multi-tenant issuer %s at startup', (issuer) => {
    expect(isMultiTenantIssuer(issuer)).toBe(true);
    expect(() => loadEnv({ ...BASE_ENV, ...COMPLETE, SSO_OIDC_ISSUER: issuer })).toThrow(
      /multi-tenant/,
    );
  });

  it('does not mistake a tenant id or host for a multi-tenant segment', () => {
    expect(isMultiTenantIssuer(ENTRA_ISSUER)).toBe(false);
    expect(isMultiTenantIssuer('https://common.example.com/realms/x')).toBe(false);
  });

  it('refuses a non-https or malformed issuer, but allows loopback http for dev', () => {
    const problems = (issuer: string) =>
      ssoEnvProblems({ SSO_OIDC_ISSUER: issuer, ...COMPLETE, SSO_ALLOWED_TENANT_ID: undefined });
    expect(problems('http://idp.example.com')).toEqual([expect.stringContaining('must use https')]);
    expect(problems('not a url')).toEqual([expect.stringContaining('absolute URL')]);
    expect(problems('http://localhost:8080/realms/x')).toEqual([]);
  });

  it('refuses an allowed tenant id that is not a GUID, using the shared rule', () => {
    expect(() =>
      loadEnv({
        ...BASE_ENV,
        ...COMPLETE,
        SSO_OIDC_ISSUER: ENTRA_ISSUER,
        SSO_ALLOWED_TENANT_ID: 'contoso',
      }),
    ).toThrow(/SSO_ALLOWED_TENANT_ID: must be a tenant id/);
  });
});
