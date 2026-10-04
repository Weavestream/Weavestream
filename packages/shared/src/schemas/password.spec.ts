import { createPasswordSchema, updatePasswordSchema } from './password.js';

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
