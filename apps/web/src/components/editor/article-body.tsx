import type { ArticleEditorMode } from '@weavestream/shared';
import { MarkdownView } from './markdown-view';
import { RichTextView } from './rich-text-view';

/**
 * Render the body of an article in either read-only Tiptap or
 * read-only Markdown depending on `editorMode`. Keeping the branch in
 * one place ensures admin and portal views stay in lockstep — there is
 * exactly one switch statement instead of one per page.
 */
export function ArticleBody({
  editorMode,
  content,
  markdownSource,
  className,
}: {
  editorMode: ArticleEditorMode;
  content: unknown;
  markdownSource: string | null;
  className?: string;
}) {
  if (editorMode === 'markdown') {
    return <MarkdownView source={markdownSource ?? ''} className={className} />;
  }
  return <RichTextView value={content} className={className} />;
}
