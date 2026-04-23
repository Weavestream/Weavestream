/**
 * Byte-order marks that authoritatively identify a file as text in a
 * specific Unicode encoding. Windows Notepad, BitLocker recovery key
 * exports, Excel-exported CSVs, and friends routinely prefix saved
 * text files with one of these.
 *
 * We peek for them before calling `file-type` because that library
 * intentionally ignores text encodings and can mis-detect BOM-prefixed
 * text as binary formats whose magic pattern overlaps the BOM bytes.
 * The most common false positive in production is UTF-16 LE's `FF FE`
 * satisfying the 11-bit MPEG audio frame-sync pattern, which caused
 * legitimate `.txt` uploads (e.g. BitLocker Recovery Keys) to be
 * rejected as `audio/mpeg`.
 *
 * The UTF-32 BOMs must be checked before the UTF-16 LE BOM because
 * `FF FE 00 00` starts with the UTF-16 LE BOM; a naive check would
 * short-circuit on the shorter prefix and hide the 32-bit case. We
 * sort by descending length to make the precedence unambiguous.
 */
const TEXT_BOMS: ReadonlyArray<Uint8Array> = [
  new Uint8Array([0xff, 0xfe, 0x00, 0x00]), // UTF-32 LE
  new Uint8Array([0x00, 0x00, 0xfe, 0xff]), // UTF-32 BE
  new Uint8Array([0xef, 0xbb, 0xbf]), // UTF-8
  new Uint8Array([0xff, 0xfe]), // UTF-16 LE
  new Uint8Array([0xfe, 0xff]), // UTF-16 BE
];

/**
 * Returns true if `buffer` starts with any recognised text BOM. Intended
 * to be called on the raw stored object bytes during upload confirmation.
 */
export function startsWithTextBom(buffer: Uint8Array): boolean {
  for (const bom of TEXT_BOMS) {
    if (buffer.length < bom.length) continue;
    let match = true;
    for (let i = 0; i < bom.length; i++) {
      if (buffer[i] !== bom[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
