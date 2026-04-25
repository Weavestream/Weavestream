'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import { useMemo } from 'react';
import { getArticleBodyExtensions } from './article-tiptap-extensions';
import { normaliseTiptapDoc } from '../../lib/tiptap-doc';
import './editor.css';

/**
 * Read-only Tiptap renderer — portal pages and article-read view use this.
 * We keep the extension list in sync with the editor so round-tripping a
 * document between edit and view is lossless. Mentions render as inert
 * pills (no suggestion pipeline in read mode).
 */
export function RichTextView({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  const content = useMemo(() => normaliseTiptapDoc(value), [value]);
  const extensions = useMemo(() => getArticleBodyExtensions(), []);
  const editor = useEditor(
    {
      editable: false,
      extensions,
      content,
      immediatelyRender: false,
    },
    [content, extensions],
  );

  if (!editor) return null;

  return (
    <div className={className}>
      <EditorContent
        editor={editor}
        className={`sd-editor sd-editor-article sd-richtext-view`}
      />
    </div>
  );
}
