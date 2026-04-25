import type { Extensions } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Mention from '@tiptap/extension-mention';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { ResizableImage } from './image-extension';

/**
 * Extension set for article body HTML generation / JSON import — must
 * match [rich-text-view.tsx](./rich-text-view.tsx) for lossless
 * Tiptap ↔ Markdown round-tripping in `article-format.ts`.
 */
export function getArticleBodyExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
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
  ];
}
