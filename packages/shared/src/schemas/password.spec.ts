import { createPasswordSchema, updatePasswordSchema } from './password.js';

describe('password url — schema-level trim', () => {
  const base = { name: 'Core router', password: 'hunter2' };

  it('trims leading/trailing whitespace on create', () => {
    const parsed = createPasswordSchema.parse({
      ...base,
      url: '  example.com  ',
    });
    expect(parsed.url).toBe('example.com');
  });

  it('trims on update and passes null / absent through untouched', () => {
    expect(
      updatePasswordSchema.parse({ url: ' https://a.example ' }).url,
    ).toBe('https://a.example');
    expect(updatePasswordSchema.parse({ url: null }).url).toBeNull();
    expect(updatePasswordSchema.parse({ name: 'renamed' }).url).toBeUndefined();
  });

  it('applies the length cap to the trimmed value, not the raw input', () => {
    const max = 'a'.repeat(2048);
    const parsed = createPasswordSchema.parse({ ...base, url: `  ${max}  ` });
    expect(parsed.url).toBe(max);
  });

  it('reduces whitespace-only to empty string (forms null it; render treats it as absent)', () => {
    const parsed = createPasswordSchema.parse({ ...base, url: '   ' });
    expect(parsed.url).toBe('');
  });
});
