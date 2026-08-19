import Mention, { type MentionNodeAttrs } from '@tiptap/extension-mention';
import { ReactRenderer } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
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

export type MentionLinkOpts = {
  isAdmin: boolean;
  portalSlugForCompany?: (companyId: string) => string | null;
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
} & MentionLinkOpts) {
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
        slug?: string | null;
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
          ...(attrs.slug ? { 'data-slug': attrs.slug } : {}),
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
            slug: item.slug ?? null,
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
        slug: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-slug'),
          renderHTML: (attrs) =>
            attrs.slug ? { 'data-slug': attrs.slug as string } : {},
        },
      };
    },
    addProseMirrorPlugins() {
      const parentPlugins = this.parent?.() ?? [];
      return [
        ...parentPlugins,
        new Plugin({
          props: {
            handleClick(_view, _pos, event) {
              if (!(event.metaKey || event.ctrlKey)) return false;
              const target = event.target as HTMLElement | null;
              const anchor = target?.closest?.('a.sd-mention') as
                | HTMLAnchorElement
                | null;
              if (!anchor) return false;
              const href = anchor.getAttribute('href');
              if (!href || href === '#') return false;
              event.preventDefault();
              window.location.assign(href);
              return true;
            },
          },
        }),
      ];
    },
  });
}

export function mentionHref(
  attrs: {
    id: string;
    kind: 'asset' | 'article' | 'password';
    companyId: string;
    slug?: string | null;
  },
  opts: MentionLinkOpts,
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
  const companySlug = opts.portalSlugForCompany?.(attrs.companyId) ?? null;
  if (!companySlug) return '#';
  if (attrs.kind === 'asset') return `/portal/${companySlug}/assets/${attrs.id}`;
  if (attrs.kind === 'password')
    return `/portal/${companySlug}/passwords/${attrs.id}`;
  // Portal article routes are slug-keyed; the mention picker persists
  // the article's slug on insertion. Legacy mentions without a stored
  // slug fall back to an in-app id→slug resolver route.
  if (attrs.slug)
    return `/portal/${companySlug}/articles/${encodeURIComponent(attrs.slug)}`;
  return `/portal/${companySlug}/articles/by-id/${attrs.id}`;
}
