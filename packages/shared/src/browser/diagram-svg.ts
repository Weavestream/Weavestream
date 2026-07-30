import { safeProseHref } from '../safe-external-href.js';

/**
 * The one sanitizer for Mermaid-rendered SVG, shared by `apps/web` and
 * `apps/mobile`.
 *
 * It lives here rather than in either app because there must be exactly
 * one policy and mobile cannot import from `apps/web`. Both DOMPurify
 * and the CSS parser are **injected**, and the parameter types below are
 * local structural interfaces rather than imports, so this package gains
 * no runtime dependency and no type crosses a workspace boundary.
 *
 * ## What the caller gets
 *
 * A **detached** `DocumentFragment`. Nothing here ever attaches anything
 * to a live document — that is the caller's job, behind its own
 * staleness check (see each app's `MermaidBlock`). Committing from in
 * here would mean the commit had already happened by the time the
 * caller's `await` resumed, so a "was this run superseded?" check would
 * be inspecting DOM it had already overwritten.
 *
 * ## Four gates, in order
 *
 *  (a) DOMPurify with an explicit ALLOWLIST → an inert fragment.
 *  (b) URL gate over `href`/`xlink:href` AND the URL-capable SVG
 *      presentation attributes.
 *  (c) CSS gate over `<style>` contents and `style=` attributes.
 *  (d) — not here. Selector containment is the caller's shadow root;
 *      this module rejects `:host`/`:host-context` in (c) because those
 *      are the selectors designed to reach *through* that boundary.
 *
 * ## Honest framing of what each gate buys
 *
 * Gate (a) is not catching something Mermaid's own `securityLevel:
 * 'strict'` DOMPurify pass misses today. It exists so that a future
 * config change cannot silently remove the only sanitizer in the path,
 * and because Mermaid's own pass uses a *profile*, which is wider than
 * the allowlist below.
 *
 * Gate (c) **is** new coverage: Mermaid does not CSS-sanitize its own
 * output, and its `<style>` block is generated partly from the diagram's
 * `classDef` statements — i.e. from author-controlled text. That is
 * precisely the surface behind GHSA-87f9-hvmw-gh4p and
 * GHSA-xcj9-5m2h-648r.
 *
 * Never set `securityLevel: 'loose'` (re-enables click callbacks and
 * drops Mermaid's own sanitizer) or `'sandbox'` (returns an
 * `<iframe src="data:…">` that `default-src 'self'` blocks).
 */

/** Structural, deliberately — see the module comment. */
export interface PurifierLike {
  sanitize(html: string, config: Record<string, unknown>): DocumentFragment;
}

/**
 * Read-only: the CSS gate VALIDATES and never edits an AST, so
 * `visit(node)` is sufficient and `generate` is not in the trust path at
 * all. Node removal would need the walker's `(node, item, list)`
 * arguments plus `list.remove` — one more reason validate-and-keep-the-
 * original beats mutate-and-re-emit: the bytes that reach the DOM are
 * the bytes that were inspected.
 */
export interface CssParserLike {
  parse(css: string, options: { context: string; positions?: boolean }): unknown;
  walk(
    ast: never,
    visit: (node: { type: string; name?: string; value?: unknown }) => void,
  ): void;
}

export interface DiagramSanitizeDeps {
  purify: PurifierLike;
  css: CssParserLike;
}

const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** A same-document reference, the only URL shape non-`<a>` elements get. */
const FRAGMENT_RE = /^#[\w:.-]+$/;

/**
 * HTML mermaid emits inside `foreignObject` labels. Nothing else: the
 * `html` USE_PROFILE would additionally admit `<video>`, `<audio>`,
 * `<source>`, `<track>`, `<form>`, `<input>` and `<button>`, all of which
 * carry URL attributes that gate (b) does not look at and DOMPurify
 * happily preserves ordinary http(s) URLs on.
 */
const FOREIGN_HTML_TAGS = [
  'div',
  'span',
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'a',
];

/**
 * SVG elements Mermaid emits.
 *
 * Derived from the corpus fixtures in `__fixtures__/mermaid-corpus/`,
 * not from memory — a hand-written list missed `<filter>` and
 * `<feDropShadow>` (node drop shadows) outright, and that failure is
 * silent: the diagram renders, just flat. `diagram-svg.spec.ts` runs the
 * corpus through this allowlist, so a Mermaid upgrade that emits
 * something new fails a test instead of quietly degrading a runbook.
 */
const SVG_TAGS = [
  'svg',
  'g',
  'defs',
  'style',
  'title',
  'desc',
  'marker',
  'path',
  'line',
  'polyline',
  'polygon',
  'rect',
  'circle',
  'ellipse',
  'text',
  'tspan',
  'textpath',
  'use',
  'symbol',
  'clippath',
  'mask',
  'pattern',
  'lineargradient',
  'radialgradient',
  'stop',
  'foreignobject',
  'switch',
  // Filter primitives — Mermaid's default node shadow. Only the ones it
  // actually emits: this is not the full filter vocabulary, and adding
  // the rest speculatively would widen the surface for nothing.
  'filter',
  'fedropshadow',
];

const SVG_ATTRS = [
  'id',
  'class',
  'style',
  'name',
  'title',
  'transform',
  'transform-origin',
  'd',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'viewbox',
  'preserveaspectratio',
  'points',
  'fill',
  'fill-opacity',
  'fill-rule',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'marker-start',
  'marker-mid',
  'marker-end',
  'markerwidth',
  'markerheight',
  'markerunits',
  'refx',
  'refy',
  'orient',
  'clip-path',
  'clippathunits',
  'mask',
  'maskunits',
  'gradientunits',
  'gradienttransform',
  'offset',
  'stop-color',
  'stop-opacity',
  // feDropShadow
  'flood-color',
  'flood-opacity',
  'stddeviation',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'word-spacing',
  'white-space',
  'dx',
  'dy',
  'xml:space',
  'requiredfeatures',
  'requiredextensions',
  'systemlanguage',
  'shape-rendering',
  'vector-effect',
  'visibility',
  'display',
  'cursor',
  'role',
  'aria-roledescription',
  'xmlns',
  'xmlns:xlink',
];

/**
 * Presentation attributes parsed as CSS *values*, which may legitimately
 * carry `url(…)` — including an external one.
 *
 * These are the gap between gate (b)'s href check and gate (c)'s
 * `<style>`/`style=` check: none is an `href`, none is inside a `style`
 * attribute, and DOMPurify allows all of them.
 */
const URL_CAPABLE_PRESENTATION_ATTRS = [
  'fill',
  'stroke',
  'filter',
  'clip-path',
  'mask',
  'marker-start',
  'marker-mid',
  'marker-end',
  'cursor',
];

/**
 * At-rules that may survive. An allowlist, so anything new is rejected
 * by default — `@import` and `@font-face` are the ones that fetch.
 *
 * `keyframes` is here because Mermaid emits it for animated edges. Its
 * body holds only `from`/`to`/percentage blocks, which cannot carry a
 * selector that reaches out of the diagram.
 */
const ATRULE_ALLOW = new Set(['media', 'supports', 'keyframes']);

/**
 * Selectors that reach the light-DOM host from inside a shadow root.
 * `:host{position:fixed;inset:0;z-index:9999}` would turn a diagram into
 * a full-viewport overlay; there is no legitimate use in Mermaid output.
 */
const HOST_PSEUDOS = new Set(['host', 'host-context']);

/**
 * CSS functions that may appear in a value. **An allowlist, because
 * checking `Url` nodes alone is not enough.**
 *
 * `image-set("https://…" 1x)` and `image("https://…")` take their
 * address as a *quoted string*, which css-tree models as a `String`
 * inside a `Function` — no `Url` node exists, so a `Url`-only gate lets
 * the request through. CSS Images 4 defines those strings as URLs; the
 * parser simply does not label them that way. A denylist of URL-bearing
 * functions would then have to keep pace with every new one
 * (`cross-fade`, `element`, `-webkit-image-set`, …), so allowlist
 * instead and let anything unrecognised fail closed.
 *
 * This exact set is what real Mermaid output uses, derived from the
 * corpus fixtures — see `diagram-svg.spec.ts`, which re-derives it and
 * fails if Mermaid starts emitting something new. None of them takes a
 * URL in any form.
 */
const FUNCTION_ALLOW = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'var',
  'calc',
  'drop-shadow',
  'translate',
  'translatex',
  'translatey',
  'rotate',
  'scale',
  'matrix',
  'cubic-bezier',
  'steps',
]);

/**
 * css-tree node types the gate understands.
 *
 * `Raw` is absent **on purpose, and it is the point of this list.**
 * css-tree is intentionally tolerant: syntax it cannot model becomes a
 * `Raw` node rather than an exception, so "reject if parse() throws" is
 * NOT fail-closed — uninspected CSS would sail through. Anything not
 * named here fails the whole style unit.
 */
const KNOWN_NODE_TYPES = new Set([
  'StyleSheet',
  'Rule',
  'SelectorList',
  'Selector',
  'TypeSelector',
  'ClassSelector',
  'IdSelector',
  'AttributeSelector',
  'PseudoClassSelector',
  'PseudoElementSelector',
  'Combinator',
  'Nth',
  'NthSelector',
  'AnPlusB',
  'Identifier',
  'Block',
  'Declaration',
  'DeclarationList',
  'Value',
  'Dimension',
  'Percentage',
  'Number',
  'String',
  'Hash',
  'Url',
  'Function',
  'Operator',
  'Parentheses',
  'Atrule',
  'AtrulePrelude',
  'MediaQueryList',
  'MediaQuery',
  'Feature',
  'FeatureFunction',
  'FeatureRange',
  'Condition',
  'SupportsDeclaration',
  'Ratio',
  'UnicodeRange',
  'Comment',
  'Scope',
  'Layer',
  'LayerList',
  'GeneralEnclosed',
]);

/**
 * Named character references an SVG serializer may leave inside a
 * `<style>` element.
 *
 * This matters because of a parsing asymmetry: SVG is XML, so a browser
 * decodes entities inside `<style>`; DOMPurify parses the string as
 * HTML, where `<style>` is a raw-text element and entities are NOT
 * decoded. Mermaid really does emit `&gt;` for the child combinator in a
 * `classDef`, so without this every diagram carrying one would fail the
 * gate and render unstyled.
 *
 * Decoding before validation is the SAFE direction: we check the more
 * permissive of the two readings, and the bytes actually attached are
 * the original ones, which can only be a broken subset of what we
 * approved — never something extra.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Whether `text` is CSS this app is willing to attach.
 *
 * Validate-only: on success the caller keeps the ORIGINAL text, so no
 * serializer sits between inspection and the DOM.
 */
function cssIsSafe(
  css: CssParserLike,
  text: string,
  context: 'stylesheet' | 'declarationList' | 'value',
): boolean {
  return cssNodeIsSafe(css, decodeXmlEntities(text), context, 0);
}

/** `depth` bounds the Raw re-parse below; 1 is all Mermaid ever needs. */
function cssNodeIsSafe(
  css: CssParserLike,
  text: string,
  context: 'stylesheet' | 'declarationList' | 'value',
  depth: number,
): boolean {
  if (text.trim() === '') return true;

  let ast: unknown;
  try {
    ast = css.parse(text, { context, positions: false });
  } catch {
    return false;
  }

  let ok = true;
  try {
    css.walk(ast as never, (node) => {
      if (!ok) return;

      if (node.type === 'Raw') {
        // css-tree is deliberately tolerant: syntax it does not model
        // becomes Raw rather than an exception, which is why "reject on
        // throw" is not fail-closed. But a blanket rejection is too
        // blunt — css-tree returns Raw for perfectly ordinary values
        // such as a quoted font stack. So accept a Raw only if its
        // contents fully re-parse under the same rules; anything still
        // unmodellable after that is rejected.
        if (
          depth >= 1 ||
          !cssNodeIsSafe(css, String(node.value ?? ''), 'value', depth + 1)
        ) {
          ok = false;
        }
        return;
      }

      if (!KNOWN_NODE_TYPES.has(node.type)) {
        ok = false;
        return;
      }
      if (node.type === 'Atrule' && !ATRULE_ALLOW.has(node.name ?? '')) {
        ok = false;
        return;
      }
      if (
        node.type === 'PseudoClassSelector' &&
        HOST_PSEUDOS.has((node.name ?? '').toLowerCase())
      ) {
        ok = false;
        return;
      }
      if (
        node.type === 'Function' &&
        !FUNCTION_ALLOW.has((node.name ?? '').toLowerCase())
      ) {
        // Closes the string-form URL hole: `image-set("https://…")`
        // carries its address as a String, not a Url, so the check below
        // never sees it.
        ok = false;
        return;
      }
      if (node.type === 'Url') {
        const url = urlValue(node);
        // An unreadable shape is treated as unsafe, same as a bad URL.
        if (url === null || !FRAGMENT_RE.test(url)) ok = false;
      }
    });
  } catch {
    return false;
  }
  return ok;
}

/**
 * A Url node's target, or `null` when the node's shape is not one this
 * gate can read.
 *
 * `null` rather than an unmatchable sentinel string, so the caller has
 * to handle "unreadable" explicitly instead of relying on the sentinel
 * happening to fail `FRAGMENT_RE`. The sentinel this replaces was a
 * literal NUL byte, which additionally made git and ripgrep treat this
 * security-critical file as binary — no diff in review, invisible to a
 * grep.
 */
function urlValue(node: { value?: unknown }): string | null {
  if (typeof node.value === 'string') return node.value.trim();
  // Older css-tree shapes nested a String node.
  const nested = (node.value as { value?: unknown } | undefined)?.value;
  return typeof nested === 'string' ? nested.trim() : null;
}

/**
 * Sanitize a Mermaid-rendered SVG string into a detached fragment.
 *
 * Throws nothing: an unparseable style is dropped, an unsafe URL is
 * dropped, and the diagram renders with less rather than failing.
 */
export function sanitizeDiagramSvg(
  svg: string,
  deps: DiagramSanitizeDeps,
): DocumentFragment {
  // (a) DOMPurify parses into its own document, which has no browsing
  // context: nothing executes, nothing fetches, no handler binds. The
  // dangerous nodes are gone before anything is live — which is also why
  // this is not DOMParser + adoptNode, where an SVG <script> carries no
  // "already started" flag and runs the instant it is inserted.
  const fragment = deps.purify.sanitize(svg, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [...SVG_TAGS, ...FOREIGN_HTML_TAGS],
    ALLOWED_ATTR: [...SVG_ATTRS, 'href', 'xlink:href', 'target', 'rel'],
    // `aria-*` and `data-*` are governed by their OWN switches, not by
    // ALLOWED_ATTR — a literal 'aria-*' entry above would do nothing, and
    // leaving ALLOW_DATA_ATTR at its `true` default would let every
    // data- attribute through regardless of the list.
    ALLOW_ARIA_ATTR: true,
    ALLOW_DATA_ATTR: false,
    // `foreignobject` is neither allowed by default nor an HTML
    // integration point in DOMPurify 3.4.x. ADD_TAGS restores the
    // element; without HTML_INTEGRATION_POINTS the HTML nested inside it
    // still fails the namespace check and is stripped — silently blanking
    // every flowchart label. Mermaid's own internal config sets both.
    ADD_TAGS: ['foreignobject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  });

  gateUrls(fragment, deps);
  gateStyles(fragment, deps);
  return fragment;
}

/** (b) href / xlink:href, plus the URL-capable presentation attributes. */
function gateUrls(root: ParentNode, deps: DiagramSanitizeDeps): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const isAnchor = el.tagName.toLowerCase() === 'a';

    for (const [ns, name] of [
      [null, 'href'],
      [XLINK_NS, 'href'],
    ] as const) {
      const raw = ns === null ? el.getAttribute(name) : el.getAttributeNS(ns, name);
      if (raw === null) continue;

      // Only <a> may leave the document. Everything else — <use>,
      // <textPath>, filter and gradient references — is a same-document
      // fragment or it is nothing.
      const safe = isAnchor
        ? safeProseHref(raw)
        : FRAGMENT_RE.test(raw.trim())
          ? raw.trim()
          : null;

      if (safe === null) {
        if (ns === null) el.removeAttribute(name);
        else el.removeAttributeNS(ns, name);
        continue;
      }

      if (ns === null) el.setAttribute(name, safe);
      else el.setAttributeNS(ns, `xlink:${name}`, safe);

      if (isAnchor && !safe.startsWith('#')) {
        // Exactly `ProseLink`'s split: pure fragments stay same-tab
        // (a same-document jump gains nothing from a new tab), and
        // everything else — including rooted same-origin paths — opens
        // in one. Matching the existing policy matters more than the
        // marginal in-app-navigation nicety, and `noopener` on a link
        // inside author-controlled content is the conservative default.
        el.setAttribute('rel', 'noopener noreferrer');
        el.setAttribute('target', '_blank');
      }
    }

    for (const attr of URL_CAPABLE_PRESENTATION_ATTRS) {
      const value = el.getAttribute(attr);
      if (value === null || !value.includes('(')) continue;
      if (!cssIsSafe(deps.css, value, 'value')) el.removeAttribute(attr);
    }
  }
}

/** (c) `<style>` contents and `style=` attributes. */
function gateStyles(root: ParentNode, deps: DiagramSanitizeDeps): void {
  for (const styleEl of Array.from(root.querySelectorAll('style'))) {
    if (!cssIsSafe(deps.css, styleEl.textContent ?? '', 'stylesheet')) {
      // Unstyled but safe is the correct direction to fail. Dropping the
      // whole element rather than editing it is what keeps the inspected
      // bytes and the attached bytes identical.
      styleEl.remove();
    }
  }

  for (const el of Array.from(root.querySelectorAll('[style]'))) {
    const value = el.getAttribute('style') ?? '';
    if (!cssIsSafe(deps.css, value, 'declarationList')) {
      el.removeAttribute('style');
    }
  }
}
