import type { ArticleDetail } from '@weavestream/shared';
import { TiptapView } from '../../components/richtext/TiptapView';
import { MarkdownBody } from './MarkdownBody';

/**
 * The `editorMode` switch — mobile's mirror of desktop's
 * `article-body.tsx`. The two modes populate different columns:
 * `'markdown'` carries `markdownSource` (and `content` is null);
 * `'tiptap'` carries `content` (and `markdownSource` is null).
 * `contentPlaintext` is search-index fodder, never a render source.
 */
export function ArticleBodyView({ article }: { article: ArticleDetail }) {
  if (article.editorMode === 'markdown') {
    return <MarkdownBody source={article.markdownSource ?? ''} />;
  }
  return <TiptapView doc={article.content} />;
}
