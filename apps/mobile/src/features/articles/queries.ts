import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { UUID_RE } from '../../lib/uuid';
import {
  fetchArticleDetail,
  fetchArticleFolders,
  fetchArticlesPage,
  type ArticlesPage,
} from './api';

/**
 * Query wiring for the articles feature.
 *
 * Key discipline matches passwords: everything article-shaped lives
 * under the `['articles', companyId]` prefix, which never starts with
 * `'org-scope'`/`'me'` — so the org switcher's predicate invalidation
 * evicts it all automatically on a switch.
 *
 * The list is an infinite query over the server's cursor pagination
 * (see api.ts for why fetch-all is off the table). `folderId` is part
 * of the key: a chip change is a different server query, and the
 * abort `signal` cancels the in-flight page of the previous one.
 */

export const articleKeys = {
  all: (companyId: string | null) => ['articles', companyId] as const,
  list: (companyId: string | null, folderId?: string) =>
    ['articles', companyId, 'list', folderId ?? null] as const,
  detail: (companyId: string | null, articleId: string) =>
    ['articles', companyId, 'detail', articleId] as const,
  folders: (companyId: string | null) => ['articles', companyId, 'folders'] as const,
};

export function useArticlesInfinite(companyId: string | null, folderId?: string) {
  return useInfiniteQuery({
    queryKey: articleKeys.list(companyId, folderId),
    queryFn: ({ pageParam, signal }) =>
      fetchArticlesPage(companyId!, { folderId, cursor: pageParam, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ArticlesPage) => last.nextCursor,
    enabled: companyId !== null,
  });
}

export function useArticleDetail(companyId: string | null, articleId: string) {
  return useQuery({
    queryKey: articleKeys.detail(companyId, articleId),
    queryFn: () => fetchArticleDetail(companyId!, articleId),
    // The UUID guard belongs to the screen's wrapper (it renders
    // not-found without mounting this hook), but `enabled` re-states it
    // so a future caller can't fire a guaranteed-400 request.
    enabled: companyId !== null && UUID_RE.test(articleId),
  });
}

/** Shared by the list's chips and the detail's folder-name lookup. */
export function useArticleFolders(companyId: string | null) {
  return useQuery({
    queryKey: articleKeys.folders(companyId),
    queryFn: () => fetchArticleFolders(companyId!),
    enabled: companyId !== null,
  });
}
