#!/usr/bin/env node
/**
 * Browser-level verification for the diagram feature. Run in CI.
 *
 * Answers the two questions jsdom structurally cannot, and that would
 * otherwise only be discovered in production:
 *
 *  1. **Does Mermaid render under the PRODUCTION CSP?** The desktop
 *     policy permits `'unsafe-eval'` in DEV ONLY, so a Mermaid version
 *     that reached `eval`/`new Function` would pass every local check
 *     and fail silently once deployed. This serves the real production
 *     policy and renders the whole corpus, failing on any violation.
 *
 *  2. **Does `ctx.fillStyle`'s getter really refuse to convert
 *     `oklch()`?** That is the premise `toSrgbHex` in
 *     `packages/shared/src/browser/css-color.ts` is built on: reading the
 *     getter back proves only that the value PARSED, so the conversion
 *     has to rasterize. jsdom has no canvas at all and always takes the
 *     null fallback, so this cannot be asserted anywhere else.
 *
 * Deliberately no Playwright/Puppeteer dependency: this drives the
 * already-cached Chromium over the DevTools protocol with Node's own
 * `WebSocket` and `node:http`, exactly like `mermaid-corpus.mjs`.
 *
 * Set WS_CHROMIUM to point at a browser if the cache lookup misses.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = resolve(
  WEB,
  '../../packages/shared/src/browser/__fixtures__/mermaid-corpus',
);
const DIST = resolve(WEB, 'node_modules/mermaid/dist');

/**
 * Byte-identical to `desktopDirectives()` in `apps/web/src/lib/csp.ts`
 * for a production (non-dev) request. `'unsafe-eval'` is absent, which
 * is the whole point — if this list drifts from csp.ts the check stops
 * meaning anything, so keep them in step.
 */
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'nonce-testnonce' 'strict-dynamic'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const PAGE = `<!doctype html><meta charset="utf-8">
<body data-theme="dark" data-accent="lime"><div id="host"></div>
<script nonce="testnonce" type="module">
window.__violations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.__violations.push(e.violatedDirective + ' :: ' + (e.blockedURI || '') + ' :: ' + (e.sourceFile || ''));
});
window.__err = null;
try {
  const { default: mermaid } = await import('/dist/mermaid.esm.min.mjs');
  mermaid.initialize({
    startOnLoad: false, theme: 'base', securityLevel: 'strict',
    htmlLabels: true, suppressErrorRendering: true,
    flowchart: { curve: 'basis', useMaxWidth: true }, handDrawnSeed: 1,
  });
  window.__render = async (id, src) => {
    const { svg } = await mermaid.render(id, src, document.getElementById('host'));
    return svg.length;
  };
  window.__ready = true;
} catch (e) { window.__err = String((e && e.stack) || e); }
</script></body>`;

function serve() {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const headers = { 'content-security-policy': PROD_CSP };
    if (url.startsWith('/dist/')) {
      const target = resolve(DIST, `.${url.slice('/dist'.length)}`);
      if (!target.startsWith(DIST) || !existsSync(target)) return res.writeHead(404, headers).end();
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript' });
      return readFile(target).then((b) => res.end(b), () => res.writeHead(500).end());
    }
    res.writeHead(200, { ...headers, 'content-type': 'text/html' });
    res.end(PAGE);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

class Cdp {
  #ws; #next = 1; #pending = new Map();
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.#next++;
    this.#ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }
  close() { this.#ws.close(); }
}

async function findChromium() {
  if (process.env.WS_CHROMIUM) return process.env.WS_CHROMIUM;
  const home = process.env.HOME ?? '';
  const roots = [join(home, 'Library/Caches/ms-playwright'), join(home, '.cache/ms-playwright')].filter(existsSync);
  const names = new Set(['chrome-headless-shell', 'chrome', 'Chromium']);
  const dig = async (dir, d) => {
    if (d > 3) return null;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isFile() && names.has(e.name)) return full;
      if (e.isDirectory()) { const f = await dig(full, d + 1); if (f) return f; }
    }
    return null;
  };
  for (const root of roots) for (const e of await readdir(root)) if (e.startsWith('chromium')) { const f = await dig(join(root, e), 0); if (f) return f; }
  return null;
}

const { server, port } = await serve();
const bin = await findChromium();
if (!bin) {
  console.error('\n\u2716 diagram CSP check: no cached Chromium found. Set WS_CHROMIUM, or run `npx playwright install chromium`.\n');
  process.exit(1);
}
const child = spawn(bin, ['--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((r) => { let b = ''; child.stderr.on('data', (c) => { b += c; const m = /ws:\/\/[^\s]+/.exec(b); if (m) r(m[0]); }); });
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const cdp = new Cdp(ws);

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` }, sessionId);

const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

for (let i = 0; i < 100; i += 1) { if (await ev('window.__ready === true')) break; await new Promise((r) => setTimeout(r, 100)); }

const fail = [];
const ok = [];

if (!(await ev('window.__ready === true'))) {
  fail.push(`harness never ready: ${await ev('window.__err')}`);
} else {
  ok.push('mermaid module loaded under production CSP (no unsafe-eval)');

  // 1. Render every corpus diagram under the production CSP.
  for (const f of (await readdir(CORPUS)).filter((f) => f.endsWith('.mmd'))) {
    const src = await readFile(join(CORPUS, f), 'utf8');
    try {
      const len = await ev(`window.__render(${JSON.stringify('v-' + f.replace(/\W+/g, '-'))}, ${JSON.stringify(src)})`);
      if (typeof len === 'number' && len > 0) ok.push(`rendered ${f} (${len} bytes)`);
      else fail.push(`${f} produced no SVG`);
    } catch (e) { fail.push(`${f} threw: ${String(e.message).slice(0, 200)}`); }
  }

  // 2. The colour-conversion premise.
  const probe = await ev(`(() => {
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#010203'; ctx.fillStyle = 'oklch(0.86 0.18 125)';
    const getterSays = ctx.fillStyle;
    ctx.clearRect(0,0,1,1);
    ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0,0,1,1);
    ctx.fillStyle = 'oklch(0.86 0.18 125)'; ctx.fillRect(0,0,1,1);
    const [r,g,b] = ctx.getImageData(0,0,1,1).data;
    const hex = '#' + [r,g,b].map(n=>n.toString(16).padStart(2,'0')).join('');
    ctx.fillStyle = '#010203'; ctx.fillStyle = 'not-a-color'; const a = ctx.fillStyle;
    ctx.fillStyle = '#040506'; ctx.fillStyle = 'not-a-color'; const bb = ctx.fillStyle;
    ctx.fillStyle = '#010203'; ctx.fillStyle = 'transparent'; const t1 = ctx.fillStyle;
    ctx.fillStyle = '#040506'; ctx.fillStyle = 'transparent'; const t2 = ctx.fillStyle;
    return JSON.stringify({ getterSays, hex,
      garbageUnchanged: a === '#010203' && bb === '#040506',
      transparentParses: !(t1 === '#010203' && t2 === '#040506') });
  })()`);
  const p = JSON.parse(probe);

  if (/^oklch|^color\(/.test(p.getterSays)) ok.push(`PREMISE CONFIRMED: fillStyle getter returns "${p.getterSays}" — it does NOT convert`);
  else fail.push(`premise broken: getter returned "${p.getterSays}"`);

  if (/^#[0-9a-f]{6}$/.test(p.hex)) ok.push(`pixel readback converts oklch → ${p.hex}`);
  else fail.push(`pixel readback gave "${p.hex}"`);

  if (p.garbageUnchanged) ok.push('two-sentinel check detects an unparseable colour');
  else fail.push('unparseable colour was NOT detected');

  if (p.transparentParses) ok.push('`transparent` classified as parseable (not a false failure)');
  else fail.push('`transparent` misclassified as unparseable');
}

const violations = await ev('JSON.stringify(window.__violations)');
const v = JSON.parse(violations || '[]');
if (v.length === 0) ok.push('ZERO CSP violations across all renders');
else fail.push(`CSP violations: ${JSON.stringify(v.slice(0, 5))}`);

cdp.close(); child.kill(); server.close();

console.log('\n--- PASS ---');
for (const l of ok) console.log('  ✓', l);
if (fail.length) { console.log('\n--- FAIL ---'); for (const l of fail) console.log('  ✗', l); }
console.log(`\n${ok.length} passed, ${fail.length} failed\n`);
process.exit(fail.length ? 1 : 0);
