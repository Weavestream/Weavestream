import { fieldAcceptsImages, matchesAccept } from './accept-match';

function file(name: string, type: string): File {
  return new File([new Uint8Array(4)], name, { type });
}

describe('matchesAccept', () => {
  it('absent or empty accept matches everything', () => {
    expect(matchesAccept(file('a.pdf', 'application/pdf'), undefined)).toBe(true);
    expect(matchesAccept(file('a.pdf', 'application/pdf'), [])).toBe(true);
    expect(matchesAccept(file('a.pdf', 'application/pdf'), ['  '])).toBe(true);
  });

  it('exact MIME tokens match case-insensitively with stray whitespace', () => {
    expect(matchesAccept(file('a.jpg', 'image/jpeg'), [' IMAGE/JPEG '])).toBe(true);
    expect(matchesAccept(file('a.pdf', 'application/pdf'), ['image/jpeg'])).toBe(false);
  });

  it('wildcard tokens match the type family', () => {
    expect(matchesAccept(file('a.png', 'image/png'), ['image/*'])).toBe(true);
    expect(matchesAccept(file('a.pdf', 'application/pdf'), ['image/*'])).toBe(false);
  });

  it('extension tokens match the filename case-insensitively', () => {
    expect(matchesAccept(file('PHOTO.JPG', ''), ['.jpg'])).toBe(true);
    expect(matchesAccept(file('scan.heic', ''), [' .HEIC '])).toBe(true);
    expect(matchesAccept(file('doc.pdf', 'application/pdf'), ['.jpg'])).toBe(false);
  });

  it('a file passes if ANY token matches (mixed forms)', () => {
    const accept = ['application/pdf', '.jpg'];
    expect(matchesAccept(file('a.pdf', 'application/pdf'), accept)).toBe(true);
    expect(matchesAccept(file('b.jpg', 'image/jpeg'), accept)).toBe(true);
    expect(matchesAccept(file('c.png', 'image/png'), accept)).toBe(false);
  });

  it('uses inferMime for files the browser left untyped', () => {
    // .md has no browser type on some platforms; the extension map fills in.
    expect(matchesAccept(file('notes.md', ''), ['text/markdown'])).toBe(true);
  });
});

describe('fieldAcceptsImages', () => {
  it('true for absent/empty accept', () => {
    expect(fieldAcceptsImages(undefined)).toBe(true);
    expect(fieldAcceptsImages([])).toBe(true);
  });

  it('true for image MIME, image wildcard, and image extensions', () => {
    expect(fieldAcceptsImages(['image/jpeg'])).toBe(true);
    expect(fieldAcceptsImages(['image/*'])).toBe(true);
    expect(fieldAcceptsImages(['.jpg'])).toBe(true);
    expect(fieldAcceptsImages([' .HEIC '])).toBe(true);
  });

  it('false for a non-image-only accept list (PDF-only field offers no camera)', () => {
    expect(fieldAcceptsImages(['application/pdf'])).toBe(false);
    expect(fieldAcceptsImages(['.pdf', 'text/csv'])).toBe(false);
  });

  it('true when images appear alongside other types', () => {
    expect(fieldAcceptsImages(['application/pdf', 'image/*'])).toBe(true);
  });
});
