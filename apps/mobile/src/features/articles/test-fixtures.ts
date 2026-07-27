import type { ArticleDetail, FolderNode } from '@weavestream/shared';

/**
 * Full valid wire shapes (not partials) so a schema field added later
 * fails compilation here rather than silently narrowing the tests —
 * same discipline as the passwords fixtures.
 *
 * Built as the DETAIL shape (Phase 4 split `ArticleSummary` from
 * `ArticleDetail`): detail is a strict superset, so list tests consume
 * these rows structurally as summaries while reader tests keep the
 * body fields.
 */

export function makeArticle(over: Partial<ArticleDetail> = {}): ArticleDetail {
  return {
    id: 'a0000000-0000-4000-8000-0000000000a1',
    companyId: 'c0000000-0000-4000-8000-0000000000c1',
    folderId: null,
    title: 'Pines site reboot order',
    slug: 'pines-site-reboot-order',
    editorMode: 'tiptap',
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Core switch first, then the APs.' }],
        },
      ],
    },
    markdownSource: null,
    contentPlaintext: 'Core switch first, then the APs.',
    excerpt: 'Core switch first, then the APs.',
    visibleToClients: true,
    revision: 3,
    archivedAt: null,
    createdBy: 'u0000000-0000-4000-8000-0000000000u1',
    updatedBy: 'u0000000-0000-4000-8000-0000000000u1',
    createdByUser: { id: 'u0000000-0000-4000-8000-0000000000u1', name: 'A. Reyes' },
    updatedByUser: { id: 'u0000000-0000-4000-8000-0000000000u1', name: 'A. Reyes' },
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-07-02T14:30:00.000Z',
    isStarred: false,
    hasDraft: false,
    ...over,
  };
}

export function makeMarkdownArticle(over: Partial<ArticleDetail> = {}): ArticleDetail {
  return makeArticle({
    id: 'a0000000-0000-4000-8000-0000000000a2',
    title: 'Firewall change checklist',
    slug: 'firewall-change-checklist',
    editorMode: 'markdown',
    content: null,
    markdownSource: '# Checklist\n\n- [x] snapshot config\n- [ ] apply change',
    contentPlaintext: 'Checklist snapshot config apply change',
    excerpt: 'Checklist',
    ...over,
  });
}

export function makeFolderNode(
  over: Partial<FolderNode> & { id: string; name: string },
): FolderNode {
  return {
    companyId: 'c0000000-0000-4000-8000-0000000000c1',
    parentId: null,
    slug: over.name.toLowerCase().replace(/\s+/g, '-'),
    icon: null,
    position: 0,
    archivedAt: null,
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    articleCount: 1,
    children: [],
    ...over,
  };
}
