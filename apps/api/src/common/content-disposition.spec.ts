import { OutgoingMessage } from 'node:http';
import { contentDispositionFor } from './content-disposition.js';

// Inputs are built from code points so the exact sequences under test
// are unambiguous in the source bytes.
const CAMERA = String.fromCodePoint(0x1f4f8); // 📸
const PARTY = String.fromCodePoint(0x1f389); // 🎉
const E_ACUTE = String.fromCharCode(0xe9); // é, latin-1 composed

/**
 * Node's real header validation — the layer that turned an emoji
 * filename into a 500. A value `fakeRes`-style mocks would happily
 * accept must also survive an actual `setHeader`.
 */
function expectHeaderSettable(value: string) {
  expect(() =>
    new OutgoingMessage().setHeader('Content-Disposition', value),
  ).not.toThrow();
}

function filenameStarOf(value: string): string {
  const m = value.match(/filename\*=UTF-8''(.*)$/);
  expect(m).not.toBeNull();
  return decodeURIComponent(m?.[1] ?? '');
}

describe('contentDispositionFor', () => {
  it('passes a plain ASCII name through in both parameters', () => {
    const value = contentDispositionFor('photo.png', 'inline');
    expect(value).toBe(
      `inline; filename="photo.png"; filename*=UTF-8''photo.png`,
    );
    expectHeaderSettable(value);
  });

  it('emits attachment mode', () => {
    expect(contentDispositionFor('a.zip', 'attachment')).toMatch(
      /^attachment; /,
    );
  });

  it('emoji filename produces a settable header and round-trips via filename*', () => {
    const value = contentDispositionFor(`invoice ${CAMERA}.png`, 'inline');
    expectHeaderSettable(value);
    expect(value).toContain('filename="invoice _.png"');
    expect(filenameStarOf(value)).toBe(`invoice ${CAMERA}.png`);
  });

  it('latin-1 accents are underscored in the fallback but exact in filename*', () => {
    const value = contentDispositionFor(`caf${E_ACUTE}.pdf`, 'inline');
    expectHeaderSettable(value);
    expect(value).toContain('filename="caf_.pdf"');
    expect(filenameStarOf(value)).toBe(`caf${E_ACUTE}.pdf`);
  });

  it('neutralises quoting and header-splitting characters', () => {
    const value = contentDispositionFor('he"ll\\o\r\nX: y.txt', 'attachment');
    expectHeaderSettable(value);
    expect(value).toContain('filename="he_ll_o__X: y.txt"');
  });

  it('falls back to "file" when nothing readable survives', () => {
    const value = contentDispositionFor(`${CAMERA}${PARTY}`, 'attachment');
    expectHeaderSettable(value);
    expect(value).toContain('filename="file"');
    expect(filenameStarOf(value)).toBe(`${CAMERA}${PARTY}`);
  });

  it('percent-encodes RFC 5987 attr-char exceptions in filename*', () => {
    const value = contentDispositionFor("a'b(c)*.txt", 'inline');
    expectHeaderSettable(value);
    const star = value.slice(value.indexOf("filename*=UTF-8''") + 17);
    expect(star).not.toMatch(/['()*]/);
    expect(filenameStarOf(value)).toBe("a'b(c)*.txt");
  });
});
