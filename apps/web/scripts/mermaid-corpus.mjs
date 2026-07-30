#!/usr/bin/env node
/**
 * Render every `.mmd` in the shared Mermaid corpus through the REAL
 * Mermaid, in a real browser, and write the SVG next to it.
 *
 * ## Why this lives in `apps/web` and not in `packages/shared`
 *
 * The fixtures are consumed by `packages/shared`'s sanitizer suite, but
 * that package deliberately has no Mermaid dependency — and Mermaid
 * cannot run under jest anyway, because it measures text with `getBBox`,
 * which jsdom does not implement. So checked-in SVGs could never notice a
 * Mermaid upgrade on their own: the suite would keep passing against
 * frozen output while production drifted. This script closes that loop
 * from the package that *does* have Mermaid.
 *
 * ## Why it drives Chromium directly instead of using Playwright
 *
 * A headless-browser SDK is a large dependency to carry for a
 * maintenance script. This talks to the already-cached Chromium over the
 * DevTools protocol using Node 24's built-in `WebSocket` and
 * `node:http` — the same approach the both-theme screenshot recipe uses,
 * and zero new packages.
 *
 * ## Usage
 *
 *   pnpm --filter @weavestream/web mermaid:corpus         # write
 *   pnpm --filter @weavestream/web mermaid:corpus --check  # CI: fail on drift
 *
 * `--check` is what stops a Mermaid version bump landing on stale
 * fixtures. When it fails after an upgrade, read the diff before
 * accepting it: a new element or attribute means the allowlist in
 * `packages/shared/src/browser/diagram-svg.ts` needs widening
 * deliberately.
 *
 * ## Why `--check` compares VOCABULARY and not bytes
 *
 * It used to compare the rendered SVG byte for byte, which cannot work:
 * the bytes are not reproducible across machines or even across days.
 *
 *  1. **Font metrics.** Mermaid's stylesheet asks for
 *     `"trebuchet ms", verdana, arial, sans-serif` and sizes every node
 *     by measuring its label with `getBBox`. Those fonts exist on macOS
 *     and not on the `ubuntu-24.04` runner (`playwright install
 *     --with-deps` brings Liberation/Noto, not Trebuchet), so the
 *     fallback produces different widths, viewBoxes and path
 *     coordinates. Every fixture contains text, so every fixture
 *     differed — a dev-machine render failed CI 12/12, which reads like
 *     mass staleness rather than a font difference.
 *  2. **Wall clock.** `gantt-full` emits a `<line class="today">` whose
 *     x-coordinate comes from the current date, so it drifted daily on
 *     any machine, including the one that had just written it.
 *
 * Neither moves what the corpus is FOR. The fixtures exist so
 * `diagram-svg.spec.ts` can assert that the sanitizer's allowlist keeps
 * every element, attribute and CSS function real Mermaid emits — and
 * that suite reads names, never coordinates. Forcing a different font
 * across the whole corpus moves the bytes of all 12 fixtures and the
 * vocabulary of none.
 *
 * So the gate compares the three name sets the sanitizer is built from.
 * That is reproducible anywhere, and it still fails loudly on the event
 * worth catching: a Mermaid upgrade emitting something the allowlist has
 * never seen.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The same parser `diagram-svg.ts` gates CSS with, so "which functions
// does Mermaid emit" is answered here exactly as it is in production.
import * as css from 'css-tree';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = resolve(
  WEB,
  '../../packages/shared/src/browser/__fixtures__/mermaid-corpus',
);
const MERMAID_BUNDLE = resolve(
  WEB,
  'node_modules/mermaid/dist/mermaid.esm.min.mjs',
);

const CHECK = process.argv.includes('--check');

function fail(message) {
  console.error(`\n✖ mermaid corpus: ${message}\n`);
  process.exit(1);
}

/**
 * Find a Chromium to drive. Kept as a lookup rather than a dependency —
 * a headless-browser SDK is a lot to carry for a maintenance script, and
 * both a dev machine (the screenshot recipe) and CI (`playwright
 * install chromium`) already leave one in a known cache.
 *
 * Deliberately returns `null` rather than skipping silently: a generator
 * that quietly does nothing is exactly how fixtures go stale.
 */
async function resolveChromium() {
  if (process.env['WS_CHROMIUM']) return process.env['WS_CHROMIUM'];

  const home = process.env['HOME'] ?? '';
  const roots = [
    join(home, 'Library/Caches/ms-playwright'), // macOS
    join(home, '.cache/ms-playwright'), // Linux / CI
  ].filter((p) => existsSync(p));

  // Platform-suffixed directory names differ per OS and arch
  // (`chrome-headless-shell-mac-arm64`, `chrome-linux64`, …), so search
  // for the executable by name instead of enumerating every combination.
  const EXECUTABLES = new Set(['chrome-headless-shell', 'chrome', 'Chromium']);

  async function findIn(dir, depth) {
    if (depth > 3) return null;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && EXECUTABLES.has(entry.name)) return full;
      if (entry.isDirectory()) {
        const found = await findIn(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  for (const root of roots) {
    for (const entry of await readdir(root)) {
      if (!entry.startsWith('chromium')) continue;
      const found = await findIn(join(root, entry), 0);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Serve the harness page plus Mermaid's whole `dist/` tree.
 *
 * Serving only the entry bundle is not enough, and fails in a confusing
 * way: `mermaid.esm.min.mjs` lazily `import()`s
 * `./chunks/mermaid.esm.min/<name>Diagram-<hash>.mjs`, one per diagram
 * type. With those unreachable the module resolves but every render
 * rejects — which reads like a Mermaid bug rather than a missing route.
 */
async function serve() {
  const page = `<!doctype html><meta charset="utf-8"><body><div id="host"></div>
<script type="module">
// Top-level await inside try/catch, so a module-load failure reports its
// real cause. A bare \`import\` statement failing raises an error event on
// the script element, which does NOT bubble to window — that is how this
// first presented as a page that simply never became ready.
window.__err = null;
try {
  const { default: mermaid } = await import('/dist/mermaid.esm.min.mjs');
  // Match the app's own configuration as closely as a fixture can. The
  // point is the element/attribute VOCABULARY Mermaid emits, so colours
  // are irrelevant — but securityLevel and htmlLabels must match
  // production, because those change the output SHAPE.
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'strict',
    htmlLabels: true,
    suppressErrorRendering: true,
    flowchart: { curve: 'basis', useMaxWidth: true },
    // Mermaid draws several shapes through rough.js even at the default
    // 'classic' look, and rough.js is randomized. Without a fixed seed
    // the class/state/ER/git fixtures differ on every run and --check
    // fails against output that is in fact unchanged. The app does not
    // need this — only byte-comparable fixtures do.
    handDrawnSeed: 1,
  });
  window.__render = async (id, source) => {
    const { svg } = await mermaid.render(id, source, document.getElementById('host'));
    return svg;
  };
  window.__ready = true;
} catch (e) {
  window.__err = String((e && e.stack) || e);
}
</script></body>`;

  const distRoot = resolve(MERMAID_BUNDLE, '..');
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url.startsWith('/dist/')) {
      // Path traversal guard: resolve, then verify we stayed inside.
      const target = resolve(distRoot, `.${url.slice('/dist'.length)}`);
      if (!target.startsWith(distRoot) || !existsSync(target)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/javascript' });
      readFile(target).then(
        (body) => res.end(body),
        () => res.writeHead(500).end(),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

/** Minimal CDP client over Node's built-in WebSocket. */
class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  /**
   * `sessionId` rides on the message ENVELOPE, not inside `params` —
   * flattened CDP rejects the call outright ("'Runtime.evaluate' wasn't
   * found") if it is nested, which reads like a protocol-version
   * problem rather than a routing one.
   */
  send(method, params = {}, sessionId) {
    const id = this.#next++;
    this.#ws.send(
      JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
    );
    return new Promise((resolve, reject) =>
      this.#pending.set(id, { resolve, reject }),
    );
  }

  close() {
    this.#ws.close();
  }
}

async function launch(chromium) {
  const child = spawn(
    chromium,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const wsUrl = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(
      () => rejectUrl(new Error('Chromium did not report a DevTools endpoint')),
      20_000,
    );
    let buffer = '';
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = /ws:\/\/[^\s]+/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`Chromium exited early (${code})`));
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  return { child, cdp: new Cdp(ws) };
}

/**
 * Pin the things Mermaid emits that are not a function of its input.
 *
 * `gitGraph` mints an id for every commit that has no explicit `id:` —
 * and `merge`/`cherry-pick` commits cannot be given one — so those
 * fixtures would differ on every run and `--check` would cry drift
 * against output that had not changed. (Rough.js randomness is handled
 * properly, by seeding it; this cannot be.)
 *
 * `gantt` draws a `class="today"` rule at the current date, so
 * `gantt-full.svg` otherwise picks up a new x-coordinate every day and
 * every regeneration carries a diff nobody wrote. The vocabulary gate
 * ignores coordinates, so this is not what made CI fail — it is here so
 * that running the writer twice a week apart produces the same file.
 *
 * Substituting an opaque id and a fixed abscissa is safe for what the
 * corpus is FOR: the element and attribute vocabulary, and the shape of
 * the CSS. It changes none of them.
 */
function normalize(svg) {
  return svg
    .replace(/\b\d+-[0-9a-f]{7}\b/g, 'commit-id')
    .replace(/<line\b[^>]*class="today"[^>]*>/g, (el) =>
      // Matched on the whole element so attribute order does not matter,
      // and left a real number so the fixture stays valid SVG.
      el.replace(/\b(x1|x2)="[\d.-]+"/g, '$1="0"'),
    );
}

/**
 * The three name sets `diagram-svg.ts`'s allowlist is built from.
 *
 * These extractors are deliberately the same shape as the ones in
 * `diagram-svg.spec.ts` — that suite asserts the committed fixtures
 * survive the sanitizer, this gate asserts the committed fixtures still
 * describe what Mermaid emits. They have to agree on what "vocabulary"
 * means or the two checks can pass while contradicting each other, so
 * keep the regexes in step.
 */
function vocabularyOf(svg) {
  const tags = new Set(
    [...svg.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1].toLowerCase()),
  );
  const attrs = new Set(
    [...svg.matchAll(/\s([a-zA-Z][\w:.-]*)=/g)].map((m) => m[1].toLowerCase()),
  );

  // Entities have to come back before css-tree sees the text: the
  // stylesheet is serialised into the SVG, so `>` in a selector arrives
  // as `&gt;` and would otherwise be a parse error that silently drops
  // the whole block — and a silently empty function set is a gate that
  // passes everything.
  const decode = (s) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');

  const fns = new Set();
  const chunks = [
    ...[...svg.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => [
      'stylesheet',
      m[1],
    ]),
    ...[...svg.matchAll(/\sstyle="([^"]*)"/g)].map((m) => [
      'declarationList',
      m[1],
    ]),
  ];
  for (const [context, text] of chunks) {
    let ast;
    try {
      ast = css.parse(decode(text), { context });
    } catch {
      // An unparseable chunk contributes no names. The sanitizer is
      // fail-closed on the same input, so this cannot hide a function
      // that would reach a customer.
      continue;
    }
    css.walk(ast, (node) => {
      if (node.type === 'Function') fns.add((node.name ?? '').toLowerCase());
    });
  }

  return { tags, attrs, fns };
}

const AXES = [
  ['element', 'tags'],
  ['attribute', 'attrs'],
  ['CSS function', 'fns'],
];

/**
 * What `fresh` has that `committed` does not, and vice versa. Both
 * directions matter: an addition means the allowlist may need widening,
 * a disappearance usually means a diagram feature changed shape.
 */
function vocabularyDelta(committed, fresh) {
  const before = vocabularyOf(committed);
  const after = vocabularyOf(fresh);
  const lines = [];
  for (const [label, key] of AXES) {
    const added = [...after[key]].filter((n) => !before[key].has(n)).sort();
    const removed = [...before[key]].filter((n) => !after[key].has(n)).sort();
    if (added.length > 0) lines.push(`new ${label}(s): ${added.join(', ')}`);
    if (removed.length > 0) {
      lines.push(`gone ${label}(s): ${removed.join(', ')}`);
    }
  }
  return lines;
}

async function main() {
  const chromium = await resolveChromium();
  if (!chromium) {
    fail(
      'no cached Chromium found. Set WS_CHROMIUM=/path/to/chrome, or install one\n' +
        '  (the both-theme screenshot recipe leaves one under ~/Library/Caches/ms-playwright).',
    );
  }

  const sources = (await readdir(CORPUS))
    .filter((f) => f.endsWith('.mmd'))
    .sort();
  if (sources.length === 0) fail(`no .mmd files in ${CORPUS}`);

  const { server, port } = await serve();
  const { child, cdp } = await launch(chromium);

  const drifted = [];
  const changed = [];
  try {
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    // Navigate explicitly: `Target.createTarget`'s `url` does not
    // reliably land before the first evaluate in headless-shell, which
    // shows up as a page that is simply never ready.
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${port}/` },
      sessionId,
    );
    const evaluate = async (expression) => {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      }
      return result.result.value;
    };

    // The module script is async; poll rather than guess a delay.
    for (let i = 0; i < 100; i += 1) {
      if (await evaluate('window.__ready === true')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!(await evaluate('window.__ready === true'))) {
      const pageError = await evaluate('window.__err');
      const where = await evaluate(
        'JSON.stringify({href: location.href, ready: document.readyState, err: typeof window.__err, render: typeof window.__render, scripts: document.scripts.length, body: document.body.innerHTML.slice(0,200)})',
      );
      fail(
        `the Mermaid harness page never became ready (${where})${pageError ? `: ${pageError}` : ''}`,
      );
    }

    for (const file of sources) {
      const source = await readFile(join(CORPUS, file), 'utf8');
      const id = `corpus-${file.replace(/\W+/g, '-')}`;
      const raw = await evaluate(
        `window.__render(${JSON.stringify(id)}, ${JSON.stringify(source)})`,
      );
      if (typeof raw !== 'string' || raw.length === 0) {
        fail(`${file} rendered nothing`);
      }
      const svg = normalize(raw);

      const target = join(CORPUS, file.replace(/\.mmd$/, '.svg'));
      const existing = existsSync(target)
        ? await readFile(target, 'utf8')
        : null;
      const name = file.replace(/\.mmd$/, '.svg');

      if (existing === null) {
        // A missing fixture is drift in --check (the spec would simply
        // not run it) and a plain write otherwise.
        if (CHECK) drifted.push({ name, lines: ['no committed fixture'] });
        else {
          await writeFile(target, svg, 'utf8');
          console.log(`  created ${name}`);
        }
        continue;
      }

      const lines = vocabularyDelta(existing, svg);

      if (CHECK) {
        if (lines.length > 0) drifted.push({ name, lines });
      } else {
        // Write real output, geometry and all — the fixtures are worth
        // more as genuine Mermaid renders than as a curated subset. But
        // report the vocabulary delta separately: on a machine whose
        // fonts differ from the last writer's, all 12 files change and
        // the handful of names that actually matter would otherwise be
        // buried in coordinate noise, defeating the deliberate review
        // this whole gate exists to prompt.
        if (existing !== svg) {
          await writeFile(target, svg, 'utf8');
          console.log(`  updated ${name}`);
        }
        if (lines.length > 0) changed.push({ name, lines });
      }
    }
  } finally {
    cdp.close();
    child.kill();
    server.close();
  }

  if (CHECK && drifted.length > 0) {
    fail(
      `${drifted.length} corpus fixture(s) no longer describe what Mermaid emits:\n` +
        drifted
          .map(({ name, lines }) =>
            lines.map((l) => `    ${name}: ${l}`).join('\n'),
          )
          .join('\n') +
        '\n\n  Run `pnpm --filter @weavestream/web mermaid:corpus` and review the diff.\n' +
        '  A new element or attribute means the allowlist in\n' +
        '  packages/shared/src/browser/diagram-svg.ts needs widening DELIBERATELY.\n' +
        '  (Geometry is not compared — it is font- and date-dependent. See the\n' +
        '  header of this script.)',
    );
  }

  if (!CHECK && changed.length > 0) {
    console.log('\n  Vocabulary changed — review before committing:');
    for (const { name, lines } of changed) {
      for (const line of lines) console.log(`    ${name}: ${line}`);
    }
    console.log(
      '\n  A new element, attribute or CSS function means the allowlist in\n' +
        '  packages/shared/src/browser/diagram-svg.ts needs widening DELIBERATELY.',
    );
  }

  console.log(
    CHECK
      ? `✓ ${sources.length} corpus fixtures match the installed Mermaid's vocabulary`
      : `✓ rendered ${sources.length} corpus fixtures`,
  );
}

await main();
