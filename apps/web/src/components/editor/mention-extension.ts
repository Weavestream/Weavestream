import Mention, { type MentionNodeAttrs } from '@tiptap/extension-mention';
import type { Editor, Range } from '@tiptap/react';
import { ReactRenderer } from '@tiptap/react';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { MentionList, type MentionListHandle } from './mention-list';

/**
 * Internal-link mention extension: typing `@` opens a suggestion list
 * that queries `GET /search/mentions?q=…&companyId=…` and resolves to a
 * tagged span carrying `kind`, `id`, and `href`. The rendered node is a
 * clickable pill that routes into the admin or portal article/asset view
 * depending on where it lives.
 */

export type MentionSuggestionItem = {
  kind: 'asset' | 'article' | 'password';
  id: string;
  title: string;
  companyId: string;
  companyName: string;
  slug?: string | null;
};

async function queryMentions(
  q: string,
  companyId: string,
): Promise<MentionSuggestionItem[]> {
  if (!q.trim()) return [];
  const url = `/api/v1/search/mentions?q=${encodeURIComponent(q)}&companyId=${encodeURIComponent(
    companyId,
  )}`;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return [];
    const data = (await res.json()) as { items: MentionSuggestionItem[] };
    return data.items ?? [];
  } catch {
    return [];
  }
}

export function buildMentionExtension(opts: {
  companyId: string;
  isAdmin: boolean;
  portalSlugForCompany?: (companyId: string) => string | null;
}) {
  return Mention.configure({
    HTMLAttributes: {
      class: 'sd-mention',
    },
    renderHTML({ options, node }) {
      const attrs = node.attrs as {
        id: string;
        label: string;
        kind: 'asset' | 'article' | 'password';
        companyId: string;
      };
      const href = mentionHref(attrs, opts);
      const prefix =
        attrs.kind === 'asset' ? '▥' : attrs.kind === 'password' ? '🔒' : '¶';
      return [
        'a',
        {
          ...options.HTMLAttributes,
          href,
          'data-kind': attrs.kind,
          'data-id': attrs.id,
          'data-company-id': attrs.companyId,
        },
        `${prefix} ${attrs.label}`,
      ];
    },
    renderText({ node }) {
      const attrs = node.attrs as { label: string; kind: string };
      return `@${attrs.kind}:${attrs.label}`;
    },
    suggestion: {
      char: '@',
      allowSpaces: false,
      items: async ({ query }) => queryMentions(query, opts.companyId),
      render: () => {
        let component: ReactRenderer<MentionListHandle, {
          items: MentionSuggestionItem[];
          command: (item: MentionSuggestionItem) => void;
        }> | null = null;
        let popup: TippyInstance[] | null = null;

        const toAttrs = (item: MentionSuggestionItem) =>
          ({
            id: item.id,
            label: item.title,
            kind: item.kind,
            companyId: item.companyId,
          }) as unknown as MentionNodeAttrs;

        return {
          onStart: (props) => {
            component = new ReactRenderer(MentionList, {
              props: {
                items: props.items as MentionSuggestionItem[],
                command: (item: MentionSuggestionItem) =>
                  props.command(toAttrs(item)),
              },
              editor: props.editor,
            });
            const rect = props.clientRect?.();
            if (!rect) return;
            popup = tippy('body', {
              getReferenceClientRect: () => rect,
              appendTo: () => document.body,
              content: component.element,
              showOnCreate: true,
              interactive: true,
              trigger: 'manual',
              placement: 'bottom-start',
            });
          },
          onUpdate: (props) => {
            component?.updateProps({
              items: props.items as MentionSuggestionItem[],
              command: (item: MentionSuggestionItem) =>
                props.command(toAttrs(item)),
            });
            const rect = props.clientRect?.();
            if (rect && popup?.[0]) {
              popup[0].setProps({ getReferenceClientRect: () => rect });
            }
          },
          onKeyDown: (props) => {
            if (props.event.key === 'Escape') {
              popup?.[0]?.hide();
              return true;
            }
            return component?.ref?.onKeyDown(props.event) ?? false;
          },
          onExit: () => {
            popup?.[0]?.destroy();
            component?.destroy();
            popup = null;
            component = null;
          },
        };
      },
    },
  }).extend({
    addAttributes() {
      const parent = this.parent?.() ?? {};
      return {
        ...parent,
        kind: {
          default: 'article',
          parseHTML: (el) => el.getAttribute('data-kind'),
          renderHTML: (attrs) => ({ 'data-kind': attrs.kind }),
        },
        companyId: {
          default: '',
          parseHTML: (el) => el.getAttribute('data-company-id'),
          renderHTML: (attrs) => ({ 'data-company-id': attrs.companyId }),
        },
      };
    },
  });
}

function mentionHref(
  attrs: { id: string; kind: 'asset' | 'article' | 'password'; companyId: string },
  opts: { isAdmin: boolean; portalSlugForCompany?: (companyId: string) => string | null },
): string {
  if (opts.isAdmin) {
    if (attrs.kind === 'asset') {
      return `/admin/companies/${attrs.companyId}/assets/${attrs.id}`;
    }
    if (attrs.kind === 'password') {
      return `/admin/companies/${attrs.companyId}/passwords/${attrs.id}`;
    }
    return `/admin/companies/${attrs.companyId}/articles/${attrs.id}`;
  }
  const slug = opts.portalSlugForCompany?.(attrs.companyId) ?? null;
  if (!slug) return '#';
  if (attrs.kind === 'asset') return `/portal/${slug}/assets/${attrs.id}`;
  if (attrs.kind === 'password') return `/portal/${slug}/passwords/${attrs.id}`;
  return `/portal/${slug}/articles/${attrs.id}`;
}

export type { Editor, Range };
