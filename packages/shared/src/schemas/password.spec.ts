import {
  createPasswordSchema,
  passwordVersionSummarySchema,
  restorePasswordVersionSchema,
  updatePasswordSchema,
} from './password.js';

describe('password URL validation', () => {
  const base = { name: 'Core router', password: 'hunter2' };

  it('trims leading/trailing whitespace on create', () => {
    const parsed = createPasswordSchema.parse({
      ...base,
      url: '  https://example.com/login  ',
    });
    expect(parsed.url).toBe('https://example.com/login');
  });

  it('trims on update and passes null / absent through untouched', () => {
    expect(updatePasswordSchema.parse({ url: ' https://a.example ' }).url).toBe(
      'https://a.example',
    );
    expect(updatePasswordSchema.parse({ url: null }).url).toBeNull();
    expect(updatePasswordSchema.parse({ name: 'renamed' }).url).toBeUndefined();
  });

  it('applies the length cap to the trimmed value, not the raw input', () => {
    const max = `https://example.com/${'a'.repeat(2028)}`;
    const parsed = createPasswordSchema.parse({ ...base, url: `  ${max}  ` });
    expect(parsed.url).toBe(max);
  });

  it('reduces whitespace-only to empty string (forms null it; render treats it as absent)', () => {
    const parsed = createPasswordSchema.parse({ ...base, url: '   ' });
    expect(parsed.url).toBe('');
  });

  it.each([
    'https://portal.example.com/login',
    'http://10.0.0.1:8443/admin',
    'HTTPS://Example.com/path',
  ])('accepts supported URL %s', (url) => {
    expect(createPasswordSchema.safeParse({ ...base, url }).success).toBe(true);
  });

  it.each([
    'example.com',
    'https://',
    'https://exa\nmple.com',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'ssh://host.example',
  ])('rejects malformed or unsupported URL %s', (url) => {
    expect(createPasswordSchema.safeParse({ ...base, url }).success).toBe(false);
    expect(updatePasswordSchema.safeParse({ url }).success).toBe(false);
  });
});

describe('password notes', () => {
  const base = { name: 'Core router', password: 'hunter2' };

  it('accepts plain text, including JSON-looking text, verbatim', () => {
    for (const notes of ['Rack 4', '1234', 'null', '{"a":1}']) {
      expect(createPasswordSchema.parse({ ...base, notes }).notes).toBe(notes);
    }
  });

  it('rejects a Tiptap doc — notes are text only', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
    expect(createPasswordSchema.safeParse({ ...base, notes: doc }).success).toBe(false);
    expect(updatePasswordSchema.safeParse({ notes: doc }).success).toBe(false);
  });
});

describe('password tags', () => {
  const base = { name: 'Core router', password: 'hunter2' };

  it('leaves tags out of a PATCH that does not send them', () => {
    // Zod 4 applies inner defaults inside `.optional()`; a default on the tags
    // schema would turn this rename into "clear every tag".
    const parsed = updatePasswordSchema.parse({ name: 'Renamed' });
    expect(parsed).toEqual({ name: 'Renamed' });
    expect('tags' in parsed).toBe(false);
  });

  it('rejects an empty PATCH', () => {
    expect(updatePasswordSchema.safeParse({}).success).toBe(false);
  });

  it('still clears tags when a PATCH sends an empty array', () => {
    expect(updatePasswordSchema.parse({ tags: [] }).tags).toEqual([]);
  });

  it('trims and de-duplicates tags on create and update', () => {
    expect(
      createPasswordSchema.parse({ ...base, tags: [' vpn ', 'vpn', 'edge'] }).tags,
    ).toEqual(['vpn', 'edge']);
    expect(updatePasswordSchema.parse({ tags: ['a', ' a '] }).tags).toEqual(['a']);
  });

  it('leaves tags undefined on create when omitted', () => {
    expect(createPasswordSchema.parse(base).tags).toBeUndefined();
  });
});

describe('passwordVersionSummarySchema', () => {
  const base = {
    version: 2,
    changedFields: ['username'],
    changedBy: '11111111-1111-4111-8111-111111111111',
    changedByName: 'Op',
    changeReason: null,
    createdAt: '2026-01-02T00:00:00.000Z',
  };

  it('stays backward compatible: the captured values are optional', () => {
    expect(passwordVersionSummarySchema.safeParse(base).success).toBe(true);
  });

  it('accepts captured name / username / url (nullable username and url)', () => {
    const parsed = passwordVersionSummarySchema.parse({
      ...base,
      name: 'Acme VPN',
      username: null,
      url: 'https://vpn.example.test',
    });
    expect(parsed.name).toBe('Acme VPN');
    expect(parsed.username).toBeNull();
  });
});

describe('restorePasswordVersionSchema', () => {
  it('defaults an absent body to a whole-version restore (no fields)', () => {
    expect(restorePasswordVersionSchema.parse(undefined)).toEqual({});
    expect(restorePasswordVersionSchema.parse({}).fields).toBeUndefined();
  });

  it('accepts every allow-listed field and de-duplicates', () => {
    expect(
      restorePasswordVersionSchema.parse({
        fields: ['username', 'username', 'url', 'name', 'notes', 'password', 'totp'],
      }).fields,
    ).toEqual(['username', 'url', 'name', 'notes', 'password', 'totp']);
  });

  it('rejects unknown field names, an empty list and extra keys', () => {
    expect(restorePasswordVersionSchema.safeParse({ fields: ['color'] }).success).toBe(false);
    expect(restorePasswordVersionSchema.safeParse({ fields: ['totpSecret'] }).success).toBe(false);
    expect(restorePasswordVersionSchema.safeParse({ fields: [] }).success).toBe(false);
    expect(restorePasswordVersionSchema.safeParse({ fields: ['url'], x: 1 }).success).toBe(false);
  });
});
