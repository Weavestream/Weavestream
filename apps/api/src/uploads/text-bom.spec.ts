import { startsWithTextBom } from './text-bom.js';

describe('startsWithTextBom', () => {
  it('detects UTF-8 BOM', () => {
    const buf = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(startsWithTextBom(buf)).toBe(true);
  });

  it('detects UTF-16 LE BOM (the BitLocker recovery key case)', () => {
    // `FF FE` followed by ASCII "B" encoded as UTF-16 LE.
    const buf = new Uint8Array([0xff, 0xfe, 0x42, 0x00]);
    expect(startsWithTextBom(buf)).toBe(true);
  });

  it('detects UTF-16 BE BOM', () => {
    const buf = new Uint8Array([0xfe, 0xff, 0x00, 0x42]);
    expect(startsWithTextBom(buf)).toBe(true);
  });

  it('detects UTF-32 LE BOM', () => {
    const buf = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x42, 0x00, 0x00, 0x00]);
    expect(startsWithTextBom(buf)).toBe(true);
  });

  it('detects UTF-32 BE BOM', () => {
    const buf = new Uint8Array([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x42]);
    expect(startsWithTextBom(buf)).toBe(true);
  });

  it('rejects plain ASCII with no BOM', () => {
    const buf = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(startsWithTextBom(buf)).toBe(false);
  });

  it('rejects a real MP3 frame sync', () => {
    // ID3v2 tag header — common real MP3 prefix.
    const buf = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
    expect(startsWithTextBom(buf)).toBe(false);
  });

  it('rejects MPEG audio without BOM (`FF FB` sync without `FE`)', () => {
    // MPEG-1 Layer 3 frame header without a BOM.
    const buf = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    expect(startsWithTextBom(buf)).toBe(false);
  });

  it('handles buffers shorter than any BOM', () => {
    expect(startsWithTextBom(new Uint8Array([]))).toBe(false);
    expect(startsWithTextBom(new Uint8Array([0xff]))).toBe(false);
    expect(startsWithTextBom(new Uint8Array([0xef, 0xbb]))).toBe(false);
  });
});
