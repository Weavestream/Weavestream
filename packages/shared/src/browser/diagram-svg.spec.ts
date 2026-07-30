/**
 * @jest-environment jsdom
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as css from 'css-tree';
import createDOMPurify from 'dompurify';
import { sanitizeDiagramSvg, type DiagramSanitizeDeps } from './diagram-svg';

/**
 * The security pin for BOTH surfaces — `apps/web` and `apps/mobile` call
 * the same function, so this suite is the whole policy's test.
 *
 * It runs the **real** DOMPurify and the **real** css-tree, not fakes.
 * That is why css-tree was chosen over the CSSOM: jsdom 26 implements
 * neither constructable stylesheets nor `replaceSync`, so a CSSOM-based
 * gate would take its fallback path in every test here and the suite
 * would be exercising code that never runs in production. css-tree
 * behaves identically in Node and the browser.
 *
 * Two directions matter equally. Over-permissive failures are obvious;
 * over-*restrictive* ones are silent — a stripped `<foreignObject>`
 * blanks every flowchart label with no error anywhere — so the
 * "must survive" cases below are load-bearing, not decoration.
 */

const deps: DiagramSanitizeDeps = {
  purify: createDOMPurify(window) as unknown as DiagramSanitizeDeps['purify'],
  css: css as unknown as DiagramSanitizeDeps['css'],
};

function sanitize(svg: string): DocumentFragment {
  return sanitizeDiagramSvg(svg, deps);
}

/** Serialize a fragment for whole-output assertions. */
function html(fragment: DocumentFragment): string {
  const host = document.createElement('div');
  host.appendChild(fragment.cloneNode(true));
  return host.innerHTML;
}

function wrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" role="graphics-document document">${inner}</svg>`;
}

describe('script and handler removal', () => {
  it('drops <script>', () => {
    const out = html(sanitize(wrap('<script>alert(1)</script><g></g>')));
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('drops inline event handlers', () => {
    const out = html(
      sanitize(wrap('<rect onload="alert(1)" onclick="alert(2)" width="4"/>')),
    );
    expect(out).not.toContain('onload');
    expect(out).not.toContain('onclick');
    expect(out).toContain('width="4"');
  });

  it('drops <foreignObject>-smuggled scripts but keeps the label', () => {
    const out = html(
      sanitize(
        wrap(
          '<foreignObject><div class="nodeLabel">Keep<script>alert(1)</script></div></foreignObject>',
        ),
      ),
    );
    expect(out).not.toContain('<script');
    expect(out).toContain('Keep');
  });
});

describe('network-capable and interactive elements', () => {
  // The regression an `html` USE_PROFILE plus a FORBID_TAGS denylist
  // would have failed: none of these is an <img>, none carries an href,
  // and DOMPurify preserves ordinary http(s) URLs on all of them.
  it.each([
    ['video', '<video poster="https://evil.example/p.png"></video>'],
    ['source', '<video><source src="https://evil.example/v.mp4"></video>'],
    ['audio', '<audio src="https://evil.example/a.mp3"></audio>'],
    ['track', '<video><track src="https://evil.example/t.vtt"></video>'],
    ['form', '<form action="https://evil.example/collect"><input name="x"></form>'],
    ['input', '<input name="x" value="y">'],
    ['button', '<button formaction="https://evil.example">go</button>'],
    ['image', '<image href="data:image/svg+xml;base64,AAAA"/>'],
    ['img', '<img src="https://evil.example/p.png">'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
  ])('removes <%s>', (tag, markup) => {
    const out = html(sanitize(wrap(`<foreignObject>${markup}</foreignObject>`)));
    expect(out).not.toContain(`<${tag}`);
    expect(out).not.toContain('evil.example');
  });
});

describe('URL gate — href', () => {
  it('removes a javascript: href', () => {
    const out = html(sanitize(wrap('<a xlink:href="javascript:alert(1)">x</a>')));
    expect(out).not.toContain('javascript:');
  });

  it('keeps an external link and marks it noopener', () => {
    const out = html(sanitize(wrap('<a href="https://example.com/x">x</a>')));
    expect(out).toContain('https://example.com/x');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('keeps a rooted path verbatim, in a new tab like ProseLink does', () => {
    // ProseLink's split, mirrored: only pure fragments stay same-tab.
    const out = html(sanitize(wrap('<a href="/docs/runbook">x</a>')));
    expect(out).toContain('href="/docs/runbook"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('keeps a fragment link same-tab', () => {
    const out = html(sanitize(wrap('<a href="#node-3">x</a>')));
    expect(out).toContain('href="#node-3"');
    expect(out).not.toContain('target=');
  });

  it('allows only same-document fragments on non-anchor elements', () => {
    const kept = html(sanitize(wrap('<use href="#arrowhead"/>')));
    expect(kept).toContain('href="#arrowhead"');

    const dropped = html(
      sanitize(wrap('<use href="https://evil.example/x#y"/>')),
    );
    expect(dropped).not.toContain('evil.example');
  });
});

describe('URL gate — SVG presentation attributes', () => {
  // These bypass BOTH an href check and a `style=` check: they are CSS
  // values living in plain attributes.
  it.each([
    'fill',
    'stroke',
    'filter',
    'clip-path',
    'mask',
    'marker-end',
    'cursor',
  ])('removes an external url() in %s', (attr) => {
    const out = html(
      sanitize(wrap(`<rect ${attr}="url(https://evil.example/x)" width="4"/>`)),
    );
    expect(out).not.toContain('evil.example');
    expect(out).toContain('width="4"');
  });

  it('keeps a fragment url(), which Mermaid actually uses', () => {
    const out = html(
      sanitize(wrap('<path marker-end="url(#arrowhead)" fill="url(#grad1)"/>')),
    );
    expect(out).toContain('url(#arrowhead)');
    expect(out).toContain('url(#grad1)');
  });

  it('keeps ordinary colour values untouched', () => {
    const out = html(sanitize(wrap('<rect fill="#1c1c1c" stroke="#333"/>')));
    expect(out).toContain('fill="#1c1c1c"');
    expect(out).toContain('stroke="#333"');
  });
});

describe('CSS gate', () => {
  it('drops a <style> containing @import', () => {
    const out = html(
      sanitize(wrap('<style>@import url("https://evil.example/x.css");</style>')),
    );
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('<style');
  });

  it('drops a <style> with an external url()', () => {
    const out = html(
      sanitize(
        wrap('<style>.node{background:url(https://evil.example/x.png);}</style>'),
      ),
    );
    expect(out).not.toContain('evil.example');
  });

  it.each([
    ['escaped url()', '.node{background:u\\72 l(https://evil.example/x);}'],
    ['escaped @import', '\\40 import url("https://evil.example/x.css");'],
    ['url inside image-set()', '.n{background:image-set(url(https://evil.example/a) 1x);}'],
    ['url inside @font-face src', '@font-face{src:url(https://evil.example/f.woff2);}'],
  ])('drops %s — the case a regex passes', (_label, rule) => {
    const out = html(sanitize(wrap(`<style>${rule}</style>`)));
    expect(out).not.toContain('evil.example');
  });

  it.each([
    ['image-set with a STRING address', '.n{background-image:image-set("https://evil.example/x.png" 1x);}'],
    ['image() with a string', '.n{background-image:image("https://evil.example/y.png");}'],
    ['-webkit-image-set', '.n{background-image:-webkit-image-set(url(https://evil.example/z.png) 1x);}'],
    ['cross-fade', '.n{background-image:cross-fade(url(https://evil.example/a.png) 50%);}'],
    ['a string address in a style attribute', 'background-image:image-set("https://evil.example/b.png" 1x)'],
  ])('drops %s — no Url node exists for these', (label, rule) => {
    // The hole a `Url`-only gate leaves: CSS Images 4 defines a quoted
    // string inside `image-set()`/`image()` as a URL, but css-tree models
    // it as a String inside a Function, so no Url node is ever produced.
    // The earlier test above only covered the `url(...)` form and gave
    // false confidence. Closed by allowlisting functions instead.
    // SINGLE-quoted HTML attribute: the CSS below contains double
    // quotes, and wrapping it in double quotes closed the attribute at
    // `image-set(` — the parser never saw the URL, so the assertion
    // passed without exercising anything. A test that cannot fail is
    // worse than no test on a security gate.
    const markup = label.includes('style attribute')
      ? wrap(`<rect style='${rule}' width="4"/>`)
      : wrap(`<style>${rule}</style>`);
    const out = html(sanitize(markup));
    expect(out).not.toContain('evil.example');
  });

  it('keeps the colour and transform functions Mermaid actually uses', () => {
    const out = html(
      sanitize(
        wrap(
          '<style>.n{fill:rgb(28,28,28);stroke:hsl(0,0%,20%);color:rgba(0,0,0,.5);' +
            'filter:drop-shadow(0 1px 1px hsl(0,0%,0%));transform:rotate(45deg) scale(1.1);' +
            'width:calc(100% - 4px);background:var(--x)}</style>',
        ),
      ),
    );
    expect(out).toContain('<style');
    expect(out).toContain('drop-shadow');
  });

  it('drops a style= attribute with an external url()', () => {
    const out = html(
      sanitize(
        wrap('<rect style="background:url(https://evil.example/x)" width="4"/>'),
      ),
    );
    expect(out).not.toContain('evil.example');
    expect(out).toContain('width="4"');
  });

  it('rejects :host and :host-context — they reach through the shadow boundary', () => {
    // A shadow root contains descendant selectors, but these two are
    // DESIGNED to style the light-DOM host: `:host{position:fixed;inset:0}`
    // turns a diagram into a full-viewport overlay.
    for (const rule of [
      ':host{position:fixed;inset:0;z-index:9999}',
      ':host-context(body){display:none}',
    ]) {
      const out = html(sanitize(wrap(`<style>${rule}</style>`)));
      expect(out).not.toContain('<style');
    }
  });

  it('keeps @keyframes, which Mermaid emits for animated edges', () => {
    const out = html(
      sanitize(
        wrap('<style>@keyframes dash{to{stroke-dashoffset:0;}}.e{color:#333}</style>'),
      ),
    );
    expect(out).toContain('@keyframes');
  });

  it('keeps a rule whose combinator arrived XML-encoded', () => {
    // SVG is XML, so a serializer may leave `&gt;` inside <style>; HTML
    // parsing does not decode it. Mermaid really does emit this for a
    // `classDef` child combinator, and rejecting it would leave every
    // such diagram unstyled.
    const out = html(sanitize(wrap('<style>.critical&gt;*{fill:#333}</style>')));
    expect(out).toContain('<style');
  });

  it('keeps an ordinary font stack, which css-tree models as Raw', () => {
    // The reason Raw is re-parsed rather than rejected outright: a
    // blanket rejection drops every Mermaid stylesheet, since they all
    // start with a quoted font stack.
    const out = html(
      sanitize(
        wrap('<style>.n{font-family:"trebuchet ms",verdana,arial,sans-serif;}</style>'),
      ),
    );
    expect(out).toContain('<style');
  });

  it('still rejects a hostile url() hiding inside a Raw node', () => {
    // The Raw re-parse is a relaxation, so this is the assertion that
    // keeps it honest: escapes are resolved by the sub-parse, and the
    // resulting Url node fails the fragment-only rule.
    const out = html(
      sanitize(wrap('<style>.n{background:u\\72 l(https://evil.example/x) 1x;}</style>')),
    );
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('<style');
  });

  it('is fail-closed on css-tree Raw nodes, not merely on thrown errors', () => {
    // css-tree is deliberately tolerant: unmodellable syntax becomes a
    // Raw node instead of an exception. "Reject if parse() throws" would
    // therefore let uninspected CSS through.
    const out = html(
      sanitize(wrap('<style>.n{color:red} @unknown-at-rule { ;;; !! }</style>')),
    );
    expect(out).not.toContain('<style');
  });
});

describe('must survive — over-sanitizing fails silently', () => {
  it('keeps <foreignObject> AND the HTML inside it', () => {
    // The single most important survival assertion here. Without
    // HTML_INTEGRATION_POINTS, ADD_TAGS restores the element but the
    // nested HTML fails the namespace check and is stripped — every
    // flowchart label renders blank, with no error anywhere.
    const out = html(
      sanitize(
        wrap(
          '<foreignObject width="80" height="20"><div class="nodeLabel"><span>Web tier</span></div></foreignObject>',
        ),
      ),
    );
    // SVG element names keep their camelCase through serialization even
    // though DOMPurify's config keys are lowercase.
    expect(out).toContain('<foreignObject');
    expect(out).toContain('<div');
    expect(out).toContain('Web tier');
  });

  it('keeps the accessible name', () => {
    const out = html(
      sanitize(
        wrap(
          '<title id="chart-title">Failover</title><desc>How failover works</desc><g role="group" aria-roledescription="flowchart"></g>',
        ),
      ),
    );
    expect(out).toContain('Failover');
    expect(out).toContain('How failover works');
    expect(out).toContain('aria-roledescription');
  });

  it('keeps benign <style> rules with their declarations intact', () => {
    // The assertion a CSSOM implementation would have failed under
    // jsdom, by dropping every <style> through its no-replaceSync
    // fallback.
    const out = html(
      sanitize(
        wrap(
          '<style>.node rect{fill:#1c1c1c;stroke:#333}@media (min-width:100px){.edgeLabel{color:#c8c8c8}}</style>',
        ),
      ),
    );
    expect(out).toContain('<style');
    expect(out).toContain('fill:#1c1c1c');
    expect(out).toContain('@media');
  });

  it('keeps geometry, markers and gradients', () => {
    const out = html(
      sanitize(
        wrap(
          '<defs><marker id="a" markerWidth="8" orient="auto"><path d="M0,0 L8,4"/></marker>' +
            '<linearGradient id="grad1"><stop offset="0" stop-color="#333"/></linearGradient></defs>' +
            '<g class="edgePaths"><path class="edge" d="M0,0 L10,10" marker-end="url(#a)"/></g>',
        ),
      ),
    );
    expect(out).toContain('<marker');
    expect(out).toContain('<linearGradient');
    expect(out).toContain('stop-color="#333"');
    expect(out).toContain('d="M0,0 L10,10"');
  });

  it('drops data-* but keeps aria-*, which are separate switches', () => {
    const out = html(
      sanitize(wrap('<g data-id="n1" aria-label="node" role="img"></g>')),
    );
    expect(out).not.toContain('data-id');
    expect(out).toContain('aria-label');
    expect(out).toContain('role="img"');
  });
});

describe('corpus — real Mermaid output survives the allowlist', () => {
  // Regenerate with `pnpm --filter @weavestream/web mermaid:corpus`; see
  // the fixture README. These are the diagrams a customer actually
  // authors, and the failure mode this guards is silent: an element
  // missing from the allowlist renders a flatter, emptier diagram with
  // no error anywhere. A hand-written allowlist dropped `<filter>` and
  // `<feDropShadow>` until this ran.
  const dir = join(__dirname, '__fixtures__', 'mermaid-corpus');
  const fixtures = readdirSync(dir).filter((f) => f.endsWith('.svg'));

  it('has fixtures to check (an empty corpus would pass everything)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  /**
   * The expected transformation, not an empty diff. The sanitizer is
   * SUPPOSED to remove some things, so "nothing changed" would be the
   * wrong bar and would have to be weakened on first contact.
   */
  const EXPECTED_ATTR_REMOVALS = /^data-/;

  it.each(fixtures)('%s keeps every element it renders', (file) => {
    const svg = readFileSync(join(dir, file), 'utf8');
    const before = new Set(
      [...svg.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1]!.toLowerCase()),
    );
    const after = new Set(
      [...html(sanitize(svg)).matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) =>
        m[1]!.toLowerCase(),
      ),
    );
    expect([...before].filter((t) => !after.has(t))).toEqual([]);
  });

  it.each(fixtures)('%s keeps every attribute except data-*', (file) => {
    const svg = readFileSync(join(dir, file), 'utf8');
    const attrsOf = (markup: string) =>
      new Set(
        [...markup.matchAll(/\s([a-zA-Z][\w:.-]*)=/g)].map((m) =>
          m[1]!.toLowerCase(),
        ),
      );
    const after = attrsOf(html(sanitize(svg)));
    const dropped = [...attrsOf(svg)].filter((a) => !after.has(a));
    // data-* carries Mermaid's own bookkeeping (`data-edge`, `data-look`,
    // …). It is inert once rendered — click callbacks are disabled at
    // securityLevel 'strict' — so ALLOW_DATA_ATTR stays false and these
    // are expected to go.
    expect(dropped.filter((a) => !EXPECTED_ATTR_REMOVALS.test(a))).toEqual([]);
  });

  it('uses no CSS function outside the allowlist', () => {
    // The function allowlist is fail-closed, so a Mermaid upgrade that
    // introduces a new function would silently drop the whole
    // stylesheet. Re-derive the vocabulary from real output and fail
    // here — with the offending name — rather than in a customer's
    // unstyled runbook.
    const decode = (s: string) =>
      s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
    const seen = new Set<string>();
    for (const file of fixtures) {
      const svg = readFileSync(join(dir, file), 'utf8');
      const chunks: Array<[string, string]> = [
        ...[...svg.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
          (m) => ['stylesheet', m[1]!] as [string, string],
        ),
        ...[...svg.matchAll(/\sstyle="([^"]*)"/g)].map(
          (m) => ['declarationList', m[1]!] as [string, string],
        ),
      ];
      for (const [context, text] of chunks) {
        let ast;
        try {
          ast = css.parse(decode(text), { context });
        } catch {
          continue;
        }
        css.walk(ast as never, (n: { type: string; name?: string }) => {
          if (n.type === 'Function') seen.add((n.name ?? '').toLowerCase());
        });
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    // Mirrors FUNCTION_ALLOW in diagram-svg.ts. None of these takes a URL
    // in any form — which is the property that matters.
    const allowed = new Set([
      'rgb', 'rgba', 'hsl', 'hsla', 'var', 'calc', 'drop-shadow',
      'translate', 'translatex', 'translatey', 'rotate', 'scale',
      'matrix', 'cubic-bezier', 'steps',
    ]);
    expect([...seen].filter((f) => !allowed.has(f))).toEqual([]);
  });

  it.each(fixtures)('%s keeps its <style> block', (file) => {
    // The CSS gate is fail-closed, so a benign rule shape it cannot model
    // would drop the whole stylesheet and leave the diagram unstyled —
    // again with no error. This is the over-rejection guard.
    const svg = readFileSync(join(dir, file), 'utf8');
    if (!svg.includes('<style')) return;
    expect(html(sanitize(svg))).toContain('<style');
  });
});

describe('detachment', () => {
  it('returns a fragment and attaches nothing to the live document', () => {
    // Committing is the caller's job, behind its own staleness check —
    // see each app's MermaidBlock. This assertion lives here and in the
    // runtime specs, never in the block suites, where the fragment IS
    // deliberately committed (into a shadow root).
    const before = document.body.innerHTML;
    const fragment = sanitize(wrap('<g><rect width="4"/></g>'));

    expect(fragment.nodeType).toBe(Node.DOCUMENT_FRAGMENT_NODE);
    expect(fragment.parentNode).toBeNull();
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector('svg')).toBeNull();
  });
});
