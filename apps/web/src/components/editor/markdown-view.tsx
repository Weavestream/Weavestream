'use client';

import type { CSSProperties } from 'react';
import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from './markdown-components';

/**
 * Read-only Markdown — admin + portal article views when `editorMode` is
 * `markdown`, and the markdown editor's live preview. Typography matches
 * Tiptap via shared `.sd-editor` rules.
 *
 * **Never add `rehype-raw`.** react-markdown drops raw-HTML nodes by
 * default, which is the neutralization CLAUDE.md §3 requires of stored
 * article content; enabling passthrough turns every runbook into an XSS
 * vector across the tenant boundary the client portal sits on.
 * `markdown-view.test.tsx` locks this in.
 */
export function MarkdownView({
  source,
  className,
  bodyClassName,
  bodyStyle,
  showDiagramErrors = false,
}: {
  source: string;
  className?: string;
  /** Extra classes on the `.sd-editor` body element. */
  bodyClassName?: string;
  /** Inline style on that body element. */
  bodyStyle?: CSSProperties;
  /**
   * Show Mermaid's own parse message on a failed diagram. True only in
   * the editor preview, where the author can act on it; portal readers
   * get the quiet fallback.
   */
  showDiagramErrors?: boolean;
}) {
  // The identity must be stable: react-markdown rebuilds the whole tree
  // when `components` changes, which would remount every MermaidBlock on
  // each keystroke in the editor preview.
  const components = useMemo(
    () => markdownComponents({ showDiagramErrors }),
    [showDiagramErrors],
  );

  return (
    <div className={className}>
      <div
        className={[
          'sd-editor sd-editor-article sd-richtext-view sd-markdown-view',
          bodyClassName,
        ]
          .filter(Boolean)
          .join(' ')}
        style={bodyStyle}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {source}
        </ReactMarkdown>
      </div>
    </div>
  );
}
