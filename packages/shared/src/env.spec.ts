import { envSchema, isForbiddenUploadMime } from './env.js';

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
