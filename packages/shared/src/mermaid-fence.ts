/**
 * The one definition of "this fenced code block is a Mermaid diagram",
 * shared by every surface that has to answer the question.
 *
 * Three of them do, and they were disagreeing:
 *
 *  - `apps/web` and `apps/mobile` read the `language-*` class
 *    react-markdown puts on the `<code>` element;
 *  - `apps/worker`'s PDF export parses the fence info string itself, and
 *    had its own normalisation (lower-casing, punctuation stripping)
 *    for the language it prints.
 *
 * That divergence was user-visible in the wrong direction: ```` ```MerMaid ````
 * and ``` ~~~m`ermaid ``` were captioned "Diagram — mermaid" in an
 * exported PDF while the app rendered the same block as ordinary code.
 * A caption that asserts something the product does not do is worse than
 * no caption. So the recognition rule lives here, once, and is strict:
 * the fence's language token must be exactly `mermaid`.
 *
 * Strict rather than forgiving on purpose. This decides whether
 * author-controlled text is handed to a diagram engine, and guessing at
 * near-misses is how a renderer starts doing things the author did not
 * ask for. A typo rendering as a code block is a visible, self-
 * explanatory outcome; the reverse is not.
 *
 * Framework-free (a plain object walk, no DOM and no React), so it sits
 * in the main barrel and the Nest worker can import it as readily as the
 * two React apps.
 */

/** The fence language this feature recognises. */
export const MERMAID_LANGUAGE = 'mermaid';

/**
 * The language token of a fence info string: its first word, exactly as
 * written.
 *
 * Matches how remark splits `lang` from `meta`, which is what puts
 * `language-<lang>` on the rendered `<code>` — so the PDF parser and the
 * React renderers are looking at the same token.
 */
export function fenceInfoLanguage(info: string): string {
  return info.trim().split(/\s/, 1)[0] ?? '';
}

/** Whether a fence language means "render this as a Mermaid diagram". */
export function isMermaidLanguage(language: string | null | undefined): boolean {
  return language === MERMAID_LANGUAGE;
}

/**
 * The minimal hast shape this module reads. Declared structurally rather
 * than imported from `hast`: the apps' spec tsconfigs resolve modules
 * with `moduleResolution: Node`, which cannot follow that types-only
 * package, and nothing here needs the full node type.
 */
export interface HastNodeLike {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown> | null;
  children?: HastNodeLike[];
  value?: string;
}

/**
 * The fenced source of a ```mermaid block, or `null` for any other
 * `<pre>`.
 *
 * A pure function so the routing rules are testable without rendering,
 * and shared so `apps/web` and `apps/mobile` cannot drift — they had
 * byte-identical copies of this, which CLAUDE.md's "logic shared between
 * apps belongs in packages/shared" rule exists to prevent.
 *
 * Reads only the hast tree react-markdown built, never raw HTML, so the
 * "never add `rehype-raw`" posture of both renderers is untouched.
 */
export function mermaidSourceFromPre(
  node: HastNodeLike | undefined,
): string | null {
  if (!node?.children || node.children.length !== 1) return null;

  const child = node.children[0];
  if (!child || child.type !== 'element' || child.tagName !== 'code') {
    return null;
  }

  if (!isMermaidLanguage(languageFromClassNames(child.properties?.['className']))) {
    return null;
  }

  if (!child.children || child.children.length !== 1) return null;
  const text = child.children[0];
  if (!text || text.type !== 'text' || typeof text.value !== 'string') {
    return null;
  }

  // react-markdown keeps the fence's trailing newline; Mermaid does not
  // care, but dropping it keeps the `<pre>` fallback byte-identical to
  // what the author typed.
  return text.value.replace(/\n$/, '');
}

/** The `language-*` token from a hast className, or `null`. */
function languageFromClassNames(className: unknown): string | null {
  const classes = Array.isArray(className)
    ? className.map(String)
    : typeof className === 'string'
      ? className.split(/\s+/)
      : [];
  const match = classes.find((c) => c.startsWith('language-'));
  return match === undefined ? null : match.slice('language-'.length);
}
