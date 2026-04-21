/**
 * Some browser/codec combinations report slightly different MIME
 * strings for the same underlying format. Accept the obvious
 * equivalents rather than blanket-rejecting. This is the *only* place
 * the allowlist is loosened — the final MIME stored on the Upload row
 * is always the magic-bytes-detected one.
 */
export function mimesAreCompatible(detected: string, declared: string): boolean {
  if (detected === declared) return true;
  const pairs: Array<[string, string]> = [
    ['image/jpeg', 'image/jpg'],
    ['image/heic', 'image/heif'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
    // Windows installers and Outlook messages are both Microsoft
    // Compound File Binary (CFB) under the hood — `file-type` reports
    // `application/x-cfb` for both. Accept the common declared names.
    ['application/x-cfb', 'application/x-msi'],
    ['application/x-cfb', 'application/x-ms-installer'],
    ['application/x-cfb', 'application/vnd.ms-outlook'],
    // Some browsers still emit the legacy IE-era zip alias.
    ['application/zip', 'application/x-zip-compressed'],
  ];
  return pairs.some(
    ([a, b]) => (detected === a && declared === b) || (detected === b && declared === a),
  );
}
