/**
 * Minimal local typing for fontkit 2.x, which ships no declarations.
 * Only the surface the PDF builder consumes: parsing a vendored font
 * buffer and querying its cmap for real glyph coverage (WS CR-020).
 */
declare module 'fontkit' {
  export interface PackagedFontCmap {
    hasGlyphForCodePoint(codePoint: number): boolean;
    /** Cap height in font units (`capHeight / unitsPerEm` = em ratio). */
    capHeight: number;
    unitsPerEm: number;
  }
  export function create(buffer: Buffer): PackagedFontCmap;
}
