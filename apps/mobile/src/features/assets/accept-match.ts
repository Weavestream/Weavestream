import { inferMime } from '@weavestream/shared/browser';

/**
 * One matcher for a FILE field's `options.accept` list, driving BOTH
 * the camera-button visibility and pre-upload validation — HTML
 * `accept` is only a chooser hint, so every selected file (from either
 * input) must be validated here before upload.
 *
 * Handles all three HTML accept token forms, normalized for case and
 * stray whitespace:
 *   - exact MIME:   `image/jpeg`
 *   - wildcard:     `image/*` (family prefix match)
 *   - extension:    `.jpg`, `.heic` (filename suffix, case-insensitive)
 */

function normalizeTokens(accept: string[] | undefined): string[] {
  if (!accept) return [];
  return accept
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

function mimeMatchesToken(mime: string, token: string): boolean {
  if (token.startsWith('.')) return false;
  if (token.endsWith('/*')) return mime.startsWith(token.slice(0, -1));
  return mime === token;
}

/** Absent/empty accept → everything matches (the server allowlist still gates). */
export function matchesAccept(file: File, accept: string[] | undefined): boolean {
  const tokens = normalizeTokens(accept);
  if (tokens.length === 0) return true;
  const mime = inferMime(file).toLowerCase();
  const name = file.name.toLowerCase();
  return tokens.some((token) =>
    token.startsWith('.') ? name.endsWith(token) : mimeMatchesToken(mime, token),
  );
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
]);

/**
 * Can any image satisfy the accept list? Gates the "Take photo"
 * affordance — a PDF-only field must not offer a camera. Uses the same
 * token vocabulary as `matchesAccept`.
 */
export function fieldAcceptsImages(accept: string[] | undefined): boolean {
  const tokens = normalizeTokens(accept);
  if (tokens.length === 0) return true;
  return tokens.some((token) => {
    if (token.startsWith('.')) return IMAGE_EXTENSIONS.has(token);
    return token === 'image/*' || token.startsWith('image/');
  });
}
