'use client';

import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import type { JSONContent, Extensions } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ResizableImage } from './image-extension';
import { buildMentionExtension } from './mention-extension';
import { SlashMenu } from './slash-menu';
import { uploadFile } from '../../lib/upload-client';
import './editor.css';

/**
 * Weavestream rich-text editor. One component, two shapes:
 *   - `variant="article"`: full toolbar + headings H1-H3, images, code blocks,
 *     task lists, internal mentions.
 *   - `variant="field"`: compact bubble menu, no H1, no images, still supports
 *     mentions + bold/italic/code/links. Used from `AssetForm` for
 *     `RICH_TEXT` fields.
 *
 * The editor holds the Tiptap JSON document only; plaintext + excerpt are
 * derived server-side. Callers receive the raw JSON via `onChange`.
 */

export type RichTextEditorProps = {
  variant?: 'article' | 'field';
  value: unknown;
  onChange: (doc: unknown) => void;
  editable?: boolean;
  placeholder?: string;
  companyId: string;
  isAdmin?: boolean;
  portalSlugForCompany?: (companyId: string) => string | null;
  autoFocus?: boolean;
  /**
   * When set, the article toolbar is rendered via `createPortal` into
   * the given element instead of inline. Used by the article editor
   * page to let the toolbar span the full viewport width while the
   * prose column stays centered at its narrower maxWidth.
   */
  toolbarPortalTarget?: HTMLElement | null;
};

export function RichTextEditor({
  variant = 'article',
  value,
  onChange,
  editable = true,
  placeholder,
  companyId,
  isAdmin = true,
  portalSlugForCompany,
  autoFocus = false,
  toolbarPortalTarget,
}: RichTextEditorProps) {
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingInsertRef = useRef<Editor | null>(null);

  const mention = useMemo(
    () =>
      buildMentionExtension({
        companyId,
        isAdmin,
        portalSlugForCompany,
      }),
    [companyId, isAdmin, portalSlugForCompany],
  );

  const extensions: Extensions = useMemo(() => {
    const list: Extensions = [
      StarterKit.configure({
        heading: { levels: variant === 'article' ? [1, 2, 3] : [2, 3] },
        codeBlock: { HTMLAttributes: { class: 'sd-codeblock' } },
        // Tiptap v3 StarterKit ships a `Link` extension by default; we want
        // our own configured copy (openOnClick=false, autolink, rel attrs),
        // so disable the bundled one to avoid a duplicate-extension warning.
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow' },
      }),
      Placeholder.configure({
        placeholder: placeholder ?? (variant === 'article' ? 'Start writing…' : 'Notes…'),
        emptyEditorClass: 'is-editor-empty',
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      mention,
    ];
    if (variant === 'article') {
      list.push(ResizableImage);
      // Table support is article-only: we want full column resizing in the
      // main editor but keep the `field` variant (asset RICH_TEXT cells)
      // compact and single-block focused.
      list.push(
        Table.configure({
          resizable: true,
          HTMLAttributes: { class: 'sd-table' },
          lastColumnResizable: true,
          allowTableNodeSelection: true,
        }),
        TableRow,
        TableHeader,
        TableCell,
      );
    }
    return list;
  }, [variant, placeholder, mention]);

  const editor = useEditor(
    {
      extensions,
      content: normaliseDoc(value),
      editable,
      onUpdate: ({ editor: ed }) => {
        onChange(ed.getJSON());
      },
      editorProps: {
        attributes: {
          class: `sd-editor sd-editor-${variant}`,
        },
      },
      immediatelyRender: false,
    },
    [extensions, editable],
  );

  // Only re-seed content if parent supplies a meaningfully different document.
  // Tiptap owns the editor state during typing, so we must not `setContent`
  // on every `value` change or the cursor would reset on every keystroke.
  const lastExternalRef = useRef<string>(JSON.stringify(value ?? null));
  useEffect(() => {
    if (!editor) return;
    const incoming = JSON.stringify(value ?? null);
    if (incoming === lastExternalRef.current) return;
    const current = JSON.stringify(editor.getJSON());
    if (incoming === current) {
      lastExternalRef.current = incoming;
      return;
    }
    editor.commands.setContent(normaliseDoc(value), { emitUpdate: false });
    lastExternalRef.current = incoming;
  }, [value, editor]);

  useEffect(() => {
    if (editor && autoFocus) editor.commands.focus('end');
  }, [editor, autoFocus]);

  const onImageButton = useCallback(() => {
    pendingInsertRef.current = editor;
    fileInputRef.current?.click();
  }, [editor]);

  const onFileChosen = useCallback(
    async (file: File | undefined) => {
      const ed = pendingInsertRef.current;
      if (!ed || !file) return;
      setUploadingImage(true);
      try {
        const upload = await uploadFile({
          companyId,
          file,
          attachTo: { type: 'article' },
        });
        // Store a STABLE, non-expiring URL in the document instead of the
        // raw presigned S3 URL returned by the upload response (which
        // carries a 5-minute TTL and would render as a broken image the
        // next time the article is loaded). The `/uploads/:id/image`
        // endpoint 302-redirects to a freshly-signed URL on every hit.
        const src = `/api/v1/companies/${companyId}/uploads/${upload.id}/image`;
        ed.chain().focus().setImage({ src, alt: upload.filename }).run();
      } finally {
        setUploadingImage(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [companyId],
  );

  if (!editor) return null;

  const toolbar =
    variant === 'article' && editable ? (
      <ArticleToolbar
        editor={editor}
        onImage={onImageButton}
        uploading={uploadingImage}
      />
    ) : null;

  return (
    <div>
      {toolbar && toolbarPortalTarget
        ? createPortal(toolbar, toolbarPortalTarget)
        : toolbar}

      {editable && (
        <BubbleMenu
          editor={editor}
          shouldShow={({ editor: ed, from, to }) => {
            if (from === to) return false;
            if (!ed.isEditable) return false;
            return !ed.isActive('codeBlock');
          }}
        >
          <div className="sd-bubble">
            <ToolbarButton
              editor={editor}
              active={editor.isActive('bold')}
              onClick={() => editor.chain().focus().toggleBold().run()}
              title="Bold"
            >
              <b>B</b>
            </ToolbarButton>
            <ToolbarButton
              editor={editor}
              active={editor.isActive('italic')}
              onClick={() => editor.chain().focus().toggleItalic().run()}
              title="Italic"
            >
              <i>I</i>
            </ToolbarButton>
            <ToolbarButton
              editor={editor}
              active={editor.isActive('strike')}
              onClick={() => editor.chain().focus().toggleStrike().run()}
              title="Strikethrough"
            >
              <s>S</s>
            </ToolbarButton>
            <ToolbarButton
              editor={editor}
              active={editor.isActive('code')}
              onClick={() => editor.chain().focus().toggleCode().run()}
              title="Inline code"
            >
              <span style={{ fontFamily: 'var(--font-mono)' }}>{'<>'}</span>
            </ToolbarButton>
            <span className="sd-bubble-sep" />
            <ToolbarButton
              editor={editor}
              active={editor.isActive('link')}
              onClick={() => promptLink(editor)}
              title="Link"
            >
              ∞
            </ToolbarButton>
          </div>
        </BubbleMenu>
      )}

      <EditorContent editor={editor} />

      {editable && <SlashMenu editor={editor} />}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={(e) => onFileChosen(e.target.files?.[0])}
      />
    </div>
  );
}

function ArticleToolbar({
  editor,
  onImage,
  uploading,
}: {
  editor: Editor;
  onImage: () => void;
  uploading: boolean;
}) {
  return (
    <div className="sd-editor-toolbar">
      <div className="sd-editor-toolbar-group">
        <ToolbarButton
          editor={editor}
          active={editor.isActive('paragraph')}
          onClick={() => editor.chain().focus().setParagraph().run()}
        >
          Paragraph
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={editor.isActive('heading', { level: 1 })}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 1 }).run()
          }
        >
          H1
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={editor.isActive('heading', { level: 2 })}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={editor.isActive('heading', { level: 3 })}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
        >
          H3
        </ToolbarButton>
      </div>

      <div className="sd-editor-toolbar-group">
        <ToolbarButton
          editor={editor}
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <b>B</b>
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <i>I</i>
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <s>S</s>
        </ToolbarButton>
      </div>

      <div className="sd-editor-toolbar-group">
        <ToolbarButton
          editor={editor}
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          •
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          1.
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={editor.isActive('taskList')}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >
          ☑
        </ToolbarButton>
      </div>

      <div className="sd-editor-toolbar-group">
        <ToolbarButton
          editor={editor}
          active={editor.isActive('link')}
          onClick={() => promptLink(editor)}
        >
          ∞
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={editor.isActive('codeBlock')}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        >
          <span style={{ fontFamily: 'var(--font-mono)' }}>{'<>'}</span>
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          “”
        </ToolbarButton>
      </div>

      <div className="sd-editor-toolbar-group">
        <ToolbarButton editor={editor} onClick={onImage} disabled={uploading}>
          🖼
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run()
          }
          disabled={editor.isActive('table')}
          title="Insert table"
        >
          ⊞
        </ToolbarButton>
        <ToolbarButton
          editor={editor}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        >
          ─
        </ToolbarButton>
      </div>

      {editor.isActive('table') && <TableOpsGroup editor={editor} />}

      <div style={{ flex: 1 }} />
      {uploading && (
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          uploading image…
        </span>
      )}
    </div>
  );
}

/**
 * Contextual toolbar group that only renders while the selection is inside
 * a table. Exposes the common row/column operations plus a header-row
 * toggle and a delete-table action — matching the Tiptap table command API.
 */
function TableOpsGroup({ editor }: { editor: Editor }) {
  return (
    <div
      className="sd-editor-toolbar-group sd-editor-toolbar-group-table"
      role="group"
      aria-label="Table"
    >
      <ToolbarButton
        editor={editor}
        onClick={() => editor.chain().focus().addRowBefore().run()}
        title="Add row above"
      >
        <span aria-hidden>↑+</span>
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        onClick={() => editor.chain().focus().addRowAfter().run()}
        title="Add row below"
      >
        <span aria-hidden>↓+</span>
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        onClick={() => editor.chain().focus().deleteRow().run()}
        title="Delete row"
      >
        <span aria-hidden>−row</span>
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        onClick={() => editor.chain().focus().addColumnBefore().run()}
        title="Add column left"
      >
        <span aria-hidden>←+</span>
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        onClick={() => editor.chain().focus().addColumnAfter().run()}
        title="Add column right"
      >
        <span aria-hidden>+→</span>
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        onClick={() => editor.chain().focus().deleteColumn().run()}
        title="Delete column"
      >
        <span aria-hidden>−col</span>
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        onClick={() => editor.chain().focus().toggleHeaderRow().run()}
        title="Toggle header row"
      >
        <span aria-hidden>TH</span>
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        onClick={() => editor.chain().focus().mergeOrSplit().run()}
        title="Merge / split cells"
      >
        <span aria-hidden>⊟</span>
      </ToolbarButton>
      <ToolbarButton
        editor={editor}
        onClick={() => editor.chain().focus().deleteTable().run()}
        title="Delete table"
      >
        <span aria-hidden>⌫</span>
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  editor: _editor,
  active,
  onClick,
  disabled,
  title,
  children,
}: {
  editor: Editor;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="sd-editor-btn"
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function promptLink(editor: Editor) {
  const prior = editor.getAttributes('link').href as string | undefined;
  const url = window.prompt('URL (empty to clear)', prior ?? 'https://');
  if (url === null) return;
  if (url === '' || url === 'https://') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  try {
    new URL(url);
  } catch {
    return;
  }
  editor
    .chain()
    .focus()
    .extendMarkRange('link')
    .setLink({ href: url })
    .run();
}

function normaliseDoc(value: unknown): JSONContent {
  // Raw Tiptap doc — the shape emitted by `editor.getJSON()`.
  if (
    value &&
    typeof value === 'object' &&
    'type' in (value as Record<string, unknown>) &&
    (value as { type?: unknown }).type === 'doc'
  ) {
    return value as JSONContent;
  }
  // Legacy Phase 3 wrapper `{ v: TiptapDoc, plain: string }`. Older rows
  // were stored this way before the strategy was widened to accept raw
  // docs; unwrap so existing content still hydrates in the editor.
  if (
    value &&
    typeof value === 'object' &&
    'v' in (value as Record<string, unknown>)
  ) {
    const inner = (value as { v: unknown }).v;
    if (
      inner &&
      typeof inner === 'object' &&
      'type' in (inner as Record<string, unknown>)
    ) {
      return inner as JSONContent;
    }
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
    };
  }
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}
