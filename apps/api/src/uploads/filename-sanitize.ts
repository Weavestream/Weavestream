const FALLBACK_BASENAME = 'file';

/**
 * Normalise a client-supplied filename at the moment it enters the
 * system (upload init — the only write path for `Upload.filename`).
 * Stored names must be valid HTTP header material end to end: Node
 * rejects header values containing anything above U+00FF, so an emoji
 * kept at save time is a serving failure deferred (WS: emoji upload
 * 500). Per product decision we strip rather than preserve-and-encode.
 *
 * Steps, in order:
 *  1. NFC-compose. macOS file inputs deliver decomposed names ("é" as
 *     "e" + U+0301); composing folds those into single latin-1 code
 *     points that survive step 2. Without this every accented
 *     character in a Mac upload would be dropped.
 *  2. Drop code points beyond latin-1 (emoji, CJK, symbols) and all
 *     C0/C1 controls + DEL.
 *  3. Collapse whitespace runs (including NBSP) left behind by
 *     stripped neighbours and trim the ends.
 *  4. Never return an unusable name: empty or dots-only becomes
 *     "file"; a bare extension ("📸.png" → ".png") gets a stem so it
 *     doesn't save as a dotfile. This deliberately also renames true
 *     dotfiles (".gitignore" → "file.gitignore") — a stem that always
 *     exists beats distinguishing the two. Clamped to the schema's
 *     255-char cap, which the stem prefix could otherwise exceed.
 *
 * Output is printable latin-1 only — safe for `Content-Disposition`,
 * the storage key deriver (which applies its own stricter ASCII rule),
 * and the audit log.
 */
export function sanitizeUploadFilename(raw: string): string {
  const composed = raw.normalize('NFC');
  let kept = '';
  for (const ch of composed) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    if (cp > 0xff) continue;
    kept += ch;
  }
  const collapsed = kept.replace(/\s+/g, ' ').trim();
  let result: string;
  if (collapsed === '' || /^\.+$/.test(collapsed)) {
    result = FALLBACK_BASENAME;
  } else if (collapsed.startsWith('.')) {
    result = `${FALLBACK_BASENAME}${collapsed.replace(/^\.+/, '.')}`;
  } else {
    result = collapsed;
  }
  return result.slice(0, 255);
}
