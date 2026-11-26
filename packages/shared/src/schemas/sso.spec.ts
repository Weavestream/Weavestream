import { isSsoErrorCode, ssoConfigSchema, SSO_ERROR_CODES } from './sso.js';

describe('ssoConfigSchema', () => {
  it('carries only what the sign-in page needs', () => {
    expect(Object.keys(ssoConfigSchema.shape).sort()).toEqual(['enabled', 'localLoginEnabled', 'providerName']);
  });

  it('rejects a payload with the wrong types', () => {
    expect(ssoConfigSchema.safeParse({ enabled: 'yes', providerName: 'x', localLoginEnabled: true }).success).toBe(false);
  });
});

describe('isSsoErrorCode', () => {
  it.each([...SSO_ERROR_CODES])('accepts %s', (code) => {
    expect(isSsoErrorCode(code)).toBe(true);
  });

  it.each(['', 'denied', 'NO_ACCOUNT', null, undefined, 42])('rejects %p', (value) => {
    expect(isSsoErrorCode(value)).toBe(false);
  });
});
