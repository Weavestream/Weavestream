'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Read-only Markdown — admin + portal article views when `editorMode` is
 * `markdown`. Typography matches Tiptap via shared `.sd-editor` rules.
 */
export function MarkdownView({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="sd-editor sd-editor-article sd-richtext-view sd-markdown-view">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
      </div>
    </div>
  );
}
