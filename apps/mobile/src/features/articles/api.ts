import type { ArticleDetail, ArticleSummary, FolderNode } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';

/**
 * Fetchers for the read-only articles feature (Phase 2b).
 *
 * Responses are consumed via the shared TypeScript types, not runtime
 * Zod parses — same stance as passwords and the desktop client.
 *
 * The list endpoint has NO summary projection: every row carries the
 * full body (`content` / `markdownSource` / `contentPlaintext`). That is
 * why the list is cursor-paginated at PAGE_LIMIT instead of fetch-all —
 * an article-heavy org would otherwise pull megabytes onto a phone
 * radio just to draw cards. Folder filtering is therefore server-side
 * (`folderId`), never client-side over loaded pages.
 */

export const PAGE_LIMIT = 50;

export interface ArticlesPage {
  items: ArticleSummary[];
  nextCursor: string | null;
}

export function fetchArticlesPage(
  companyId: string,
  opts: { folderId?: string; cursor?: string | null; signal?: AbortSignal } = {},
): Promise<ArticlesPage> {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (opts.folderId) params.set('folderId', opts.folderId);
  if (opts.cursor) params.set('cursor', opts.cursor);
  return apiFetch<ArticlesPage>(`/companies/${companyId}/articles?${params}`, {
    signal: opts.signal,
  });
}

export function fetchArticleDetail(
  companyId: string,
  articleId: string,
): Promise<ArticleDetail> {
  return apiFetch<ArticleDetail>(`/companies/${companyId}/articles/${articleId}`);
}

/** The article folder tree — a different model from password folders. */
export async function fetchArticleFolders(companyId: string): Promise<FolderNode[]> {
  const res = await apiFetch<{ items: FolderNode[] }>(
    `/companies/${companyId}/folders`,
  );
  return res.items;
}
