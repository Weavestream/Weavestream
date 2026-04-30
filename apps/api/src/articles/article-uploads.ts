/**
 * Helpers to keep `Upload` rows in sync with article body content.
 *
 * The article editor embeds images by writing same-origin streaming
 * URLs straight into the document body (see
 * `apps/web/src/components/editor/rich-text-editor.tsx`):
 *
 *   /api/v1/companies/{companyId}/uploads/{uploadId}/image
 *   /api/v1/companies/{companyId}/uploads/{uploadId}/blob
 *
 * `Upload` rows are created with `attachedToType = 'article'` but no
 * `attachedToId` (the article may not exist yet at upload time), so
 * the only authoritative link between an upload and the article
 * that owns it is the URL inside the article body.
 *
 * On update we diff the body so any image the operator removed in the
 * editor disappears from the photos gallery alongside the article.
 */

import type { Prisma } from '@prisma/client';

const UPLOAD_URL_RE =
  /\/api\/v1\/companies\/[0-9a-f-]{36}\/uploads\/([0-9a-f-]{36})/gi;

/**
 * Extract every upload UUID referenced by a Tiptap document or
 * Markdown source. Any value can be passed safely — the function
 * stringifies before scanning, so escaped JSON strings, embedded HTML
 * blocks, and prose all work uniformly.
 */
export function extractEmbeddedUploadIds(
  body: Prisma.JsonValue | string | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (body === null || body === undefined) return ids;
  const haystack = typeof body === 'string' ? body : JSON.stringify(body);
  if (!haystack) return ids;
  UPLOAD_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UPLOAD_URL_RE.exec(haystack)) !== null) {
    ids.add(match[1]!.toLowerCase());
  }
  return ids;
}

/**
 * Compute the set of upload UUIDs that appeared in `before` but no
 * longer appear in `after` — i.e. the operator just unembedded them.
 */
export function diffRemovedUploadIds(
  before: Prisma.JsonValue | string | null | undefined,
  after: Prisma.JsonValue | string | null | undefined,
): string[] {
  const beforeIds = extractEmbeddedUploadIds(before);
  const afterIds = extractEmbeddedUploadIds(after);
  const removed: string[] = [];
  for (const id of beforeIds) {
    if (!afterIds.has(id)) removed.push(id);
  }
  return removed;
}
