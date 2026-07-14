'use client';

import { useCallback } from 'react';
// SHARED DOM-free walker (not the client turndown converter): the AI
// chat reads this projection, and a patch's old_text must match the
// shared-walker base the preview and server apply run against (F1). The
// two converters diverge on bullet lists, italics, and horizontal rules,
// which broke exact-match patches from the read-only article view.
import { tiptapDocToMarkdown, type ArticleEditorMode } from '@weavestream/shared';
import { useChatPageContext } from '../chat-panel/use-chat-page-context';

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
  revision,
}: {
  companyId: string;
  articleId: string;
  title: string;
  editorMode: ArticleEditorMode;
  content: unknown;
  markdownSource: string | null;
  /** The saved revision this server-rendered body is based on (WS-030). */
  revision: number;
}) {
  const getMarkdown = useCallback((): string => {
    if (editorMode === 'markdown') return markdownSource ?? '';
    try {
      return tiptapDocToMarkdown(content);
    } catch {
      return '';
    }
  }, [editorMode, content, markdownSource]);
  const getRevision = useCallback((): number | null => revision, [revision]);

  useChatPageContext({ companyId, articleId, title, getMarkdown, getRevision });
  return null;
}
