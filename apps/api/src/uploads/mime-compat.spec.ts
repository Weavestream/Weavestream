import { mimesAreCompatible } from './mime-compat.js';

describe('mimesAreCompatible', () => {
  it('accepts identical strings', () => {
    expect(mimesAreCompatible('application/pdf', 'application/pdf')).toBe(true);
  });

  it('accepts docx declared as zip when magic detects zip', () => {
    expect(
      mimesAreCompatible(
        'application/zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
  });

  it('accepts MSI and MSG declared against CFB magic', () => {
    expect(mimesAreCompatible('application/x-cfb', 'application/x-msi')).toBe(true);
    expect(mimesAreCompatible('application/x-cfb', 'application/x-ms-installer')).toBe(true);
    expect(mimesAreCompatible('application/x-cfb', 'application/vnd.ms-outlook')).toBe(true);
  });

  it('accepts zip / x-zip-compressed interchangeably', () => {
    expect(mimesAreCompatible('application/zip', 'application/x-zip-compressed')).toBe(true);
    expect(mimesAreCompatible('application/x-zip-compressed', 'application/zip')).toBe(true);
  });

  it('rejects unrelated pairs', () => {
    expect(mimesAreCompatible('application/x-cfb', 'application/pdf')).toBe(false);
    expect(mimesAreCompatible('application/zip', 'application/x-msi')).toBe(false);
  });
});
