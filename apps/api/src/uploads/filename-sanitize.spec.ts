import { sanitizeUploadFilename } from './filename-sanitize.js';

// Inputs are built from code points so the exact sequences under test
// are unambiguous in the source bytes (editors and tooling silently
// NFC-normalise pasted literals, which would defeat the NFD case).
const CAMERA = String.fromCodePoint(0x1f4f8); // 📸
const PARTY = String.fromCodePoint(0x1f389); // 🎉
const E_ACUTE = String.fromCharCode(0xe9); // é, latin-1 composed
const COMBINING_ACUTE = String.fromCharCode(0x0301); // NFD accent half
const NBSP = String.fromCharCode(0xa0);
const BELL = String.fromCharCode(0x07); // C0 control
const C1_CONTROL = String.fromCharCode(0x9f);
const CJK = String.fromCodePoint(0x5831) + String.fromCodePoint(0x544a); // 報告

describe('sanitizeUploadFilename', () => {
  it('passes a clean name through untouched', () => {
    expect(sanitizeUploadFilename('Q3 Report.pdf')).toBe('Q3 Report.pdf');
  });

  it('strips emoji and collapses the whitespace they leave behind', () => {
    expect(sanitizeUploadFilename(`Screenshot ${CAMERA} 2026.png`)).toBe(
      'Screenshot 2026.png',
    );
  });

  it('NFC-composes macOS decomposed accents instead of dropping them', () => {
    // "e" + combining acute is how a Mac file input delivers an "é";
    // composed it is latin-1 U+00E9 and survives the filter.
    expect(sanitizeUploadFilename(`cafe${COMBINING_ACUTE} menu.pdf`)).toBe(
      `caf${E_ACUTE} menu.pdf`,
    );
  });

  it('gives a stem to a name reduced to its bare extension', () => {
    expect(sanitizeUploadFilename(`${CJK}.pdf`)).toBe('file.pdf');
    expect(sanitizeUploadFilename(`${CAMERA}..png`)).toBe('file.png');
  });

  it('falls back to "file" when nothing survives', () => {
    expect(sanitizeUploadFilename(`${CAMERA}${PARTY}`)).toBe('file');
    expect(sanitizeUploadFilename('...')).toBe('file');
  });

  it('drops C0/C1 control characters without leaving gaps', () => {
    expect(sanitizeUploadFilename(`a${BELL}b${C1_CONTROL}c.txt`)).toBe(
      'abc.txt',
    );
  });

  it('collapses NBSP runs to a single space', () => {
    expect(sanitizeUploadFilename(`a${NBSP}${NBSP}b.txt`)).toBe('a b.txt');
  });

  it('clamps to 255 chars when the dotfile stem would exceed the cap', () => {
    const out = sanitizeUploadFilename(`.${'a'.repeat(254)}`);
    expect(out.startsWith('file.')).toBe(true);
    expect(out).toHaveLength(255);
  });
});
