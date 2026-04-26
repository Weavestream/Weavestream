import { generateHTML, generateJSON } from '@tiptap/html';
import type { TiptapDoc } from '@weavestream/shared';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { getArticleBodyExtensions } from '../components/editor/article-tiptap-extensions';
import { normaliseTiptapDoc } from './tiptap-doc';

const articleBodyExtensions = getArticleBodyExtensions();

/**
 * Used only when the user explicitly switches an article from Tiptap to
 * Markdown. Best-effort; some nodes may not round-trip cleanly.
 */
export function tiptapDocToMarkdown(doc: unknown): string {
  const json = normaliseTiptapDoc(doc);
  const html = generateHTML(json, articleBodyExtensions);
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  turndown.use(gfm);
  return turndown.turndown(normaliseHtmlForTurndown(html));
}

/**
 * Used only when the user explicitly switches from Markdown to Tiptap.
 */
export function markdownToTiptapDoc(src: string): TiptapDoc {
  const html = marked(src, { async: false });
  const json = generateJSON(html, articleBodyExtensions) as TiptapDoc;
  return json;
}

/**
 * Adapt Tiptap's HTML output to shapes the GFM turndown plugin can
 * actually convert. Two transforms, both scoped to `<table>` subtrees:
 *
 *   1. Promote the first row's `<td>` cells to `<th>` when no row in
 *      the table already has a `<th>`. GFM Markdown requires a header
 *      row; without one the plugin falls back to `keep` and the table
 *      survives untouched as raw HTML in the output.
 *   2. Unwrap `<p>` elements that are direct children of cells (Tiptap
 *      wraps every cell body in `<p>`, which produces multi-line cells
 *      that break GFM table grammar). Multiple paragraphs in a single
 *      cell are joined with `<br>` so their separation survives.
 *
 * Runs only in the browser. The conversion call sites are all client
 * side ("use client" components); on the server we fall back to the
 * raw HTML rather than pulling in a DOM polyfill.
 */
function normaliseHtmlForTurndown(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body><div id="root">${html}</div>`,
    'text/html',
  );
  const root = doc.getElementById('root');
  if (!root) return html;

  root.querySelectorAll('table').forEach((table) => {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return;

    const hasHeader = rows.some((tr) => tr.querySelector('th'));
    const firstRow = rows[0];
    if (!hasHeader && firstRow) {
      Array.from(firstRow.children).forEach((cell) => {
        if (cell.nodeName !== 'TD') return;
        const th = doc.createElement('th');
        for (const attr of Array.from(cell.attributes)) {
          th.setAttribute(attr.name, attr.value);
        }
        while (cell.firstChild) th.appendChild(cell.firstChild);
        cell.replaceWith(th);
      });
    }

    table.querySelectorAll('th, td').forEach((cell) => {
      const ps = Array.from(cell.children).filter(
        (c) => c.nodeName === 'P',
      ) as HTMLElement[];
      ps.forEach((p, i) => {
        while (p.firstChild) cell.insertBefore(p.firstChild, p);
        if (i < ps.length - 1) {
          cell.insertBefore(doc.createElement('br'), p);
        }
        p.remove();
      });
    });
  });

  return root.innerHTML;
}
