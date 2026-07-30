import type { ArticleDetail } from '@weavestream/shared';
import { TiptapView } from '../../components/richtext/TiptapView';
import { MarkdownBody } from '../../components/richtext/MarkdownBody';

/**
 * The `editorMode` switch — mobile's mirror of desktop's
 * `article-body.tsx`. The two modes populate different columns:
 * `'markdown'` carries `markdownSource` (and `content` is null);
 * `'tiptap'` carries `content` (and `markdownSource` is null).
 * `contentPlaintext` is search-index fodder, never a render source.
 */
export function ArticleBodyView({ article }: { article: ArticleDetail }) {
  if (article.editorMode === 'markdown') {
    // `diagrams` is opt-in and this is the only caller that opts in:
    // MarkdownBody's other call site is the Ask transcript, where the
    // source is a partially streamed answer.
    return <MarkdownBody source={article.markdownSource ?? ''} diagrams />;
  }
  return <TiptapView doc={article.content} />;
}
