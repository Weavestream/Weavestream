'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import { useMemo } from 'react';
import { getArticleBodyExtensions } from './article-tiptap-extensions';
import { normaliseTiptapDoc } from '@weavestream/shared';
import './editor.css';

/**
 * Read-only Tiptap renderer — portal pages and article-read view use this.
 * We keep the extension list in sync with the editor so round-tripping a
 * document between edit and view is lossless. Mentions render as real
 * anchor links so clicking the pill navigates to the linked record;
 * callers must pass the appropriate routing context (admin vs portal).
 *
 * `portalSlugByCompanyId` is a plain serializable map (functions cannot
 * cross the server→client boundary in Next), used to resolve mention
 * destinations on portal pages. Admin pages omit it.
 */
export function RichTextView({
  value,
  className,
  isAdmin,
  portalSlugByCompanyId,
  fallbackCompanyId,
}: {
  value: unknown;
  className?: string;
  isAdmin?: boolean;
  portalSlugByCompanyId?: Record<string, string>;
  fallbackCompanyId?: string;
}) {
  const content = useMemo(() => normaliseTiptapDoc(value), [value]);
  const extensions = useMemo(
    () =>
      getArticleBodyExtensions({
        isAdmin,
        portalSlugForCompany: portalSlugByCompanyId
          ? (cid) => portalSlugByCompanyId[cid] ?? null
          : undefined,
        fallbackCompanyId,
      }),
    [isAdmin, portalSlugByCompanyId, fallbackCompanyId],
  );
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
