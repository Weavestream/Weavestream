import { serverApiFetch } from './core';

// ---------------------------------------------------------------------
// Uploads: the company photos gallery and the upload rows it lists
// ---------------------------------------------------------------------

type ArticleLinkState = 'live' | 'versioned' | 'archived' | 'orphan';

export type UploadSummary = {
  id: string;
  companyId: string;
  uploaderId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  width: number | null;
  height: number | null;
  attachedToType: string | null;
  attachedToId: string | null;
  createdAt: string;
  thumbnailUrl: string | null;
  downloadUrl: string | null;
  /**
   * Article that embeds this upload, resolved server-side by scanning
   * article bodies. Populated only for `attachedToType === 'article'`
   * uploads — those rows store no `attachedToId` so the photos gallery
   * needs this to build a "back to article" link. Non-null for `live`,
   * `versioned`, and `archived` link states (archived still carries an
   * id+slug+title so the UI can deep-link to the archived detail page).
   */
  sourceArticle: { id: string; slug: string; title: string } | null;
  /**
   * Link state for article-attached uploads:
   *   live      — in the live body of a non-archived article
   *   versioned — only in a non-draft `ArticleVersion` of a live article
   *   archived  — only reachable through an archived article
   *   orphan    — not referenced anywhere
   * `null` for non-article uploads.
   */
  articleLinkState: ArticleLinkState | null;
};

export async function listPhotos(
  companyId: string,
  params: {
    attachedToType?: string;
    attachedToId?: string;
    limit?: number;
    cursor?: string;
    includeNonLatest?: boolean;
  } = {},
): Promise<{ items: UploadSummary[]; nextCursor: string | null }> {
  const q = new URLSearchParams();
  if (params.attachedToType) q.set('attachedToType', params.attachedToType);
  if (params.attachedToId) q.set('attachedToId', params.attachedToId);
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.includeNonLatest) q.set('includeNonLatest', '1');
  const res = await serverApiFetch<{
    items: UploadSummary[];
    nextCursor: string | null;
  }>(`/companies/${companyId}/photos${q.toString() ? `?${q.toString()}` : ''}`);
  return res.data ?? { items: [], nextCursor: null };
}
