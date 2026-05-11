'use client';

import { useCallback } from 'react';
import type { ArticleEditorMode } from '@weavestream/shared';
import { useChatPageContext } from '../chat-panel/use-chat-page-context';
import { tiptapDocToMarkdown } from '../../lib/article-format';

/**
 * Client-side bridge that lets a server-rendered article view page
 * register itself with the chat panel. The body content is captured
 * once at server-render time and re-converted on demand — the
 * read-only view does not mutate after hydration, so a stable closure
 * is fine.
 */
export function ArticleChatContext({
  companyId,
  articleId,
  title,
  editorMode,
  content,
  markdownSource,
}: {
  companyId: string;
  articleId: string;
  title: string;
  editorMode: ArticleEditorMode;
  content: unknown;
  markdownSource: string | null;
}) {
  const getMarkdown = useCallback((): string => {
    if (editorMode === 'markdown') return markdownSource ?? '';
    try {
      return tiptapDocToMarkdown(content);
    } catch {
      return '';
    }
  }, [editorMode, content, markdownSource]);

  useChatPageContext({ companyId, articleId, title, getMarkdown });
  return null;
}
