import { useMemo, type ReactNode } from 'react';
import { normaliseTiptapDoc, type TiptapNode } from '@weavestream/shared';
import { boundedInt, isRecord, str } from './attr';
import { MentionPill } from './MentionPill';
import { ProseImg } from './ProseImg';
import { ProseLink } from './ProseLink';

/**
 * Read-only renderer for stored Tiptap/ProseMirror JSON — articles in
 * `editorMode: 'tiptap'`, and (Phase 2c) asset `RICH_TEXT` field values,
 * which are a subset of the same vocabulary. A hand-rolled walker, not
 * `@tiptap/html`: the schema is fixed and read-only, and this component
 * is the only reason Tiptap would otherwise enter the mobile bundle.
 *
 * Contracts:
 *  - Input is `unknown` and ALWAYS enters through `normaliseTiptapDoc`
 *    — legacy `{ v, plain }` wrappers and bare-string values exist in
 *    the wild, and bypassing the normaliser blanks them.
 *  - Node/mark vocabulary mirrors the desktop editor's extension list
 *    (`article-tiptap-extensions.ts`) plus the legacy `internalLink`
 *    inline node. Unknown nodes render their children (or nothing),
 *    unknown marks are ignored — a new node type must never take out
 *    a runbook in a server closet.
 *  - Every attr goes through `attr.ts` extraction; stored docs are
 *    untrusted input and React throws on object-valued children.
 *  - Keys are array indexes: the tree is immutable within a render
 *    lifetime (a refetch replaces the whole `doc` prop) and no child
 *    holds state, so index keys cannot cause state bleed.
 */
export function TiptapView({
  doc,
  className = '',
}: {
  doc: unknown;
  className?: string;
}) {
  const normalised = useMemo(() => normaliseTiptapDoc(doc), [doc]);
  return (
    <div className={className ? `m-prose ${className}` : 'm-prose'}>
      <Nodes nodes={normalised.content} />
    </div>
  );
}

function Nodes({ nodes }: { nodes: unknown }) {
  if (!Array.isArray(nodes)) return null;
  return (
    <>
      {nodes.map((n, i) =>
        // Null/primitive entries and type-less records in a content array
        // are malformed data — skip them (same stance as
        // tiptapToPlaintext in shared).
        isRecord(n) && typeof n.type === 'string' ? (
          <Node key={i} node={n as unknown as TiptapNode} />
        ) : null,
      )}
    </>
  );
}

function Node({ node }: { node: TiptapNode }) {
  const attrs: Record<string, unknown> = isRecord(node.attrs) ? node.attrs : {};
  switch (node.type) {
    case 'paragraph':
      return (
        <p>
          <Nodes nodes={node.content} />
        </p>
      );
    case 'heading': {
      const level = boundedInt(attrs.level, 1, 6) ?? 1;
      const Tag = `h${level}` as 'h1';
      return (
        <Tag>
          <Nodes nodes={node.content} />
        </Tag>
      );
    }
    case 'bulletList':
      return (
        <ul>
          <Nodes nodes={node.content} />
        </ul>
      );
    case 'orderedList':
      return (
        <ol start={boundedInt(attrs.start, 1, 1_000_000)}>
          <Nodes nodes={node.content} />
        </ol>
      );
    case 'listItem':
      return (
        <li>
          <Nodes nodes={node.content} />
        </li>
      );
    case 'taskList':
      return (
        <ul data-tasklist="">
          <Nodes nodes={node.content} />
        </ul>
      );
    case 'taskItem':
      return (
        <li className="m-task">
          <input type="checkbox" checked={attrs.checked === true} disabled readOnly />
          <div className="min-w-0 flex-1">
            <Nodes nodes={node.content} />
          </div>
        </li>
      );
    case 'blockquote':
      return (
        <blockquote>
          <Nodes nodes={node.content} />
        </blockquote>
      );
    case 'codeBlock': {
      // Code blocks carry no marks — join the raw text of the children.
      const text = Array.isArray(node.content)
        ? node.content
            .filter(isRecord)
            .map((c) => str((c as TiptapNode).text) ?? '')
            .join('')
        : '';
      const language = str(attrs.language);
      return (
        <pre>
          <code data-language={language ?? undefined}>{text}</code>
        </pre>
      );
    }
    case 'horizontalRule':
      return <hr />;
    case 'hardBreak':
      return <br />;
    case 'table':
      // The scroll wrapper is non-optional: without it a wide table makes
      // the whole Screen scroll horizontally. Rows live in an explicit
      // <tbody> so the emitted HTML is valid.
      return (
        <div className="m-prose-tablewrap">
          <table>
            <tbody>
              <Nodes nodes={node.content} />
            </tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return (
        <tr>
          <Nodes nodes={node.content} />
        </tr>
      );
    case 'tableHeader':
    case 'tableCell': {
      const Cell = node.type === 'tableHeader' ? 'th' : 'td';
      return (
        <Cell
          colSpan={boundedInt(attrs.colspan, 1, 1000)}
          rowSpan={boundedInt(attrs.rowspan, 1, 1000)}
        >
          <Nodes nodes={node.content} />
        </Cell>
      );
    }
    case 'image':
      return (
        <ProseImg
          src={attrs.src}
          alt={attrs.alt}
          title={attrs.title}
          width={attrs.width}
        />
      );
    case 'mention':
    case 'internalLink':
      return <MentionPill attrs={attrs} />;
    case 'text':
      return <TextNode node={node} />;
    default:
      // Unknown block/inline: degrade to the children (or nothing) —
      // never fail closed on content.
      return node.content ? <Nodes nodes={node.content} /> : <>{str(node.text)}</>;
  }
}

function TextNode({ node }: { node: TiptapNode }) {
  const text = str(node.text);
  if (text === null) return null;

  const marks = Array.isArray(node.marks)
    ? node.marks.filter(
        (m): m is { type: string; attrs?: Record<string, unknown> } =>
          isRecord(m) && typeof m.type === 'string',
      )
    : [];

  // Non-link marks wrap innermost-out in stored order; the link mark is
  // forced OUTERMOST so the whole styled run is one tap target.
  let out: ReactNode = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        out = <strong>{out}</strong>;
        break;
      case 'italic':
        out = <em>{out}</em>;
        break;
      case 'strike':
        out = <s>{out}</s>;
        break;
      case 'code':
        out = <code>{out}</code>;
        break;
      default:
        // 'link' is applied below; unknown marks are ignored.
        break;
    }
  }

  const link = marks.find((m) => m.type === 'link');
  if (!link) return <>{out}</>;
  const linkAttrs = isRecord(link.attrs) ? link.attrs : {};
  return <ProseLink href={linkAttrs.href}>{out}</ProseLink>;
}
