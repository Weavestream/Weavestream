import { cache } from 'react';
import type {
  ArticleDetail as SharedArticleDetail,
  ArticleSummary,
  FolderNode,
  IntegrationTargetProvenance,
} from '@weavestream/shared';
import { serverApiFetch } from './core';

// ───────────────────────────────────────────────────────────────────
// Phase 4: folders and articles
// ───────────────────────────────────────────────────────────────────

export async function listFolderTree(
  companyId: string,
): Promise<FolderNode[]> {
  const res = await serverApiFetch<{ items: FolderNode[] }>(
    `/companies/${companyId}/folders/tree`,
  );
  return res.data?.items ?? [];
}

// The shared detail omits `provenance` on purpose (see `articleDetailSchema`);
// the web reader renders it, so the web type adds it back.
export type ArticleDetail = SharedArticleDetail & {
  provenance: IntegrationTargetProvenance[];
};

export type ArticlePage = { items: ArticleSummary[]; nextCursor: string | null };

export async function listArticles(
  companyId: string,
  params: {
    folderId?: string | null;
    q?: string;
    includeArchived?: boolean;
    visibleToClientsOnly?: boolean;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<ArticlePage> {
  const q = new URLSearchParams();
  if (params.folderId !== undefined)
    q.set('folderId', params.folderId === null ? 'root' : params.folderId);
  if (params.q) q.set('q', params.q);
  if (params.includeArchived) q.set('includeArchived', 'true');
  if (params.visibleToClientsOnly) q.set('visibleToClientsOnly', 'true');
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', params.cursor);
  const res = await serverApiFetch<ArticlePage>(
    `/companies/${companyId}/articles${q.toString() ? `?${q.toString()}` : ''}`,
  );
  return res.data ?? { items: [], nextCursor: null };
}

/**
 * Every article in a scope, by following the API's cursor until it runs
 * out.
 *
 * The admin browser filters titles as you type and counts its folder
 * rail off the same rows, which is only honest if it holds the whole
 * list — a page-at-a-time list would filter whichever page you happened
 * to land on. A page is cheap here: the article list projection is
 * metadata-only, so no bodies cross the wire.
 *
 * The ceiling is set high enough that reaching it is not a realistic
 * knowledge base, because the failure past it is quiet: the cut runs by
 * `(archivedAt, title, id)` across the whole company, so a folder whose
 * articles all sort past it reads 0 and looks empty rather than short.
 * Its cost is paid only by the companies that need the pages — a
 * 300-article company still makes two requests. `truncated` reports that
 * the ceiling stopped us rather than the data running out, so the caller
 * can say so instead of presenting a slice as the total.
 */
export async function listAllArticles(
  companyId: string,
  params: { folderId?: string | null; includeArchived?: boolean } = {},
): Promise<{ items: ArticleSummary[]; truncated: boolean }> {
  /** The API's own per-request ceiling; asking for more is clamped. */
  const PAGE_SIZE = 200;
  /** 50 x 200 = 10,000 articles in one company, then `truncated`. */
  const MAX_PAGES = 50;
  const items: ArticleSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await listArticles(companyId, {
      ...params,
      limit: PAGE_SIZE,
      cursor,
    });
    items.push(...res.items);
    if (!res.nextCursor) return { items, truncated: false };
    cursor = res.nextCursor;
  }
  return { items, truncated: true };
}

export async function getArticle(
  companyId: string,
  id: string,
): Promise<ArticleDetail | null> {
  const res = await serverApiFetch<ArticleDetail>(
    `/companies/${companyId}/articles/${id}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}

export async function getArticleBySlug(
  companyId: string,
  slug: string,
): Promise<ArticleDetail | null> {
  const res = await serverApiFetch<ArticleDetail>(
    `/companies/${companyId}/articles/by-slug/${encodeURIComponent(slug)}`,
  );
  if (!res.ok || !res.data) return null;
  return res.data;
}

export const getCompanyFolderTree = cache(
  async (companyId: string): Promise<FolderNode[]> =>
    listFolderTree(companyId),
);
