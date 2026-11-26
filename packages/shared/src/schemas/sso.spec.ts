import { ssoSettingsSchema, testSsoSettingsSchema, updateSsoSettingsSchema } from './sso.js';

describe('updateSsoSettingsSchema', () => {
  it('requires at least one field', () => {
    expect(updateSsoSettingsSchema.safeParse({}).success).toBe(false);
  });

  it('trims text and turns empty optional text into null', () => {
    const r = updateSsoSettingsSchema.parse({
      issuer: '  https://idp.example.test/x  ',
      allowedTenantId: '   ',
      clientId: '',
    });
    expect(r.issuer).toBe('https://idp.example.test/x');
    expect(r.allowedTenantId).toBeNull();
    expect(r.clientId).toBeNull();
  });

  it('keeps an omitted client secret omitted (keep) and rejects an empty one', () => {
    expect('clientSecret' in updateSsoSettingsSchema.parse({ enabled: true })).toBe(false);
    expect(updateSsoSettingsSchema.safeParse({ clientSecret: '' }).success).toBe(false);
  });

  it('refuses setting and clearing the secret together', () => {
    expect(
      updateSsoSettingsSchema.safeParse({ clientSecret: 'x', clearClientSecret: true }).success,
    ).toBe(false);
    expect(updateSsoSettingsSchema.safeParse({ clearClientSecret: true }).success).toBe(true);
  });

  it('requires a provider name when one is sent, and caps its length', () => {
    expect(updateSsoSettingsSchema.safeParse({ providerName: '  ' }).success).toBe(false);
    expect(updateSsoSettingsSchema.safeParse({ providerName: 'x'.repeat(61) }).success).toBe(false);
  });
});

describe('ssoSettingsSchema', () => {
  it('has no field that could carry the client secret', () => {
    const keys = Object.keys(ssoSettingsSchema.shape);
    expect(keys).toContain('clientSecretSet');
    expect(keys).not.toContain('clientSecret');
    expect(keys.some((k) => /ciphertext/i.test(k))).toBe(false);
  });
});

describe('testSsoSettingsSchema', () => {
  it('accepts an empty body (test the saved issuer)', () => {
    expect(testSsoSettingsSchema.parse({})).toEqual({});
  });
});
