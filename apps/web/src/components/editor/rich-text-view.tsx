'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Mention from '@tiptap/extension-mention';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { useMemo } from 'react';
import { ResizableImage } from './image-extension';
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
  const content = useMemo(() => normaliseDoc(value), [value]);
  const editor = useEditor(
    {
      editable: false,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          // StarterKit v3 bundles its own `Link` extension; we register a
          // separately-configured copy below, so opt out here to avoid
          // the "Duplicate extension names found: ['link']" warning.
          link: false,
        }),
        Link.configure({
          openOnClick: true,
          HTMLAttributes: {
            rel: 'noopener noreferrer nofollow',
            target: '_blank',
          },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        ResizableImage,
        // Tables are read-only here but the nodes still need to be
        // registered so persisted table docs render instead of being
        // stripped as "unknown" content.
        Table.configure({
          resizable: false,
          HTMLAttributes: { class: 'sd-table' },
        }),
        TableRow,
        TableHeader,
        TableCell,
        Mention.configure({
          HTMLAttributes: { class: 'sd-mention' },
          renderHTML({ node }) {
            const attrs = node.attrs as {
              id: string;
              label: string;
              kind?: string;
            };
            const prefix = attrs.kind === 'asset' ? '▥' : '¶';
            return [
              'span',
              {
                class: 'sd-mention',
                'data-kind': attrs.kind ?? 'article',
                'data-id': attrs.id,
              },
              `${prefix} ${attrs.label}`,
            ];
          },
        }).extend({
          addAttributes() {
            return {
              id: { default: '' },
              label: { default: '' },
              kind: { default: 'article' },
              companyId: { default: '' },
            };
          },
        }),
      ],
      content,
      immediatelyRender: false,
    },
    [content],
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

function normaliseDoc(value: unknown): import('@tiptap/react').JSONContent {
  if (
    value &&
    typeof value === 'object' &&
    'type' in (value as Record<string, unknown>)
  ) {
    return value as import('@tiptap/react').JSONContent;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
    };
  }
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}
