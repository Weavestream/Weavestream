/**
 * Maximum pixel count (width × height) any Weavestream process will fully
 * decode from an untrusted image (WS-027). A tiny, highly compressible file
 * far under the upload byte cap can declare enormous dimensions and expand
 * to gigabytes of raster memory when decoded ("decompression bomb").
 *
 * Consumers gate on the header-declared dimensions BEFORE decoding:
 *  - apps/api thumbnail generation (also passed to sharp's `limitInputPixels`
 *    as an in-libvips backstop)
 *  - apps/worker PDF export image embedding (pdfkit has no native limit, so
 *    the stored Upload dimensions are checked instead)
 *
 * 50 MP comfortably exceeds current phone/DSLR output (~24–45 MP).
 */
export const MAX_IMAGE_DECODE_PIXELS = 50_000_000;
