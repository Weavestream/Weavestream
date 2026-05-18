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
import { mentionHref, type MentionLinkOpts } from './mention-extension';

export type ArticleBodyExtensionOpts = {
  isAdmin?: boolean;
  portalSlugForCompany?: (companyId: string) => string | null;
  fallbackCompanyId?: string;
};

/**
 * Extension set for article body HTML generation / JSON import — must
 * match [rich-text-view.tsx](./rich-text-view.tsx) for lossless
 * Tiptap ↔ Markdown round-tripping in `article-format.ts`.
 *
 * The optional `opts` parameter tells the Mention renderer how to build
 * hrefs (admin route vs portal slug). Without opts, mentions degrade to
 * `href="#"` so they are still visible but inert.
 */
export function getArticleBodyExtensions(
  opts?: ArticleBodyExtensionOpts,
): Extensions {
  const linkOpts: MentionLinkOpts = {
    isAdmin: opts?.isAdmin ?? true,
    portalSlugForCompany: opts?.portalSlugForCompany,
  };
  const fallbackCompanyId = opts?.fallbackCompanyId ?? '';
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
          kind?: 'asset' | 'article' | 'password';
          companyId?: string;
          slug?: string | null;
        };
        const kind = attrs.kind ?? 'article';
        const companyId = attrs.companyId || fallbackCompanyId;
        const href = companyId
          ? mentionHref(
              { id: attrs.id, kind, companyId, slug: attrs.slug ?? null },
              linkOpts,
            )
          : '#';
        const prefix =
          kind === 'asset' ? '▥' : kind === 'password' ? '🔒' : '¶';
        return [
          'a',
          {
            class: 'sd-mention',
            href,
            'data-kind': kind,
            'data-id': attrs.id,
            'data-company-id': companyId,
            ...(attrs.slug ? { 'data-slug': attrs.slug } : {}),
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
          slug: { default: null },
        };
      },
    }),
  ];
}
