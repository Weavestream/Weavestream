/**
 * Content-Security-Policy construction for every response `proxy.ts`
 * serves.
 *
 * Extracted from `proxy.ts` so it is unit-testable: that module imports
 * `NextResponse` as a runtime value, which drags `next/server` into any
 * spec that touches it. This file imports nothing, which is the same
 * reason `api-proxy.ts` is testable while `proxy.ts` is not (see the note
 * in `client-ip.spec.ts`). Before this split, no test asserted the CSP
 * header string at all — a header that silently regresses.
 *
 * Two policies, chosen by path. See `buildCsp`.
 */

/**
 * True for the mobile PWA's own routes.
 *
 * The exact-or-slash form is load-bearing. A bare `startsWith('/m')`
 * would also match `/me`, `/me/*`, `/mfa/*`, and `/manifest.webmanifest`,
 * silently serving those Next-rendered pages the nonce-less policy below
 * — which strips `'strict-dynamic'` and breaks Next's own bootstrap.
 */
export function isMobileAppPath(pathname: string): boolean {
  return pathname === '/m' || pathname.startsWith('/m/');
}

export interface CspOptions {
  pathname: string;
  /** Per-request nonce. Unused by the `/m` branch, which has no inline script. */
  nonce: string;
  isDev: boolean;
  isHttps: boolean;
}

export function buildCsp({
  pathname,
  nonce,
  isDev,
  isHttps,
}: CspOptions): string {
  const directives = isMobileAppPath(pathname)
    ? mobileDirectives()
    : desktopDirectives(nonce, isDev);

  // HSTS + upgrade-insecure-requests only make sense when the current
  // request was actually HTTPS. On plain http://localhost:3000 both would
  // force the browser to try TLS on a port that isn't serving it.
  return [...directives, ...(isHttps ? ['upgrade-insecure-requests'] : [])].join(
    '; ',
  );
}

/**
 * The main app: Next.js injects the per-request nonce into its own
 * bootstrap when it sees `strict-dynamic`, and everything else loads
 * transitively from there.
 */
function desktopDirectives(nonce: string, isDev: boolean): string[] {
  // Next.js dev server (webpack HMR + React Refresh) relies on eval() to
  // hot-swap modules. Permit it in development only; production CSP stays
  // strict (nonce + strict-dynamic, no unsafe-eval).
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  // Dev also needs websocket access for HMR; production keeps connect-src tight.
  const connectSrc = ['connect-src', "'self'", ...(isDev ? ['ws:', 'wss:'] : [])].join(
    ' ',
  );

  // Every thumbnail, attachment, logo, and export PDF is streamed
  // through the API (`/uploads/:id/image`, `/export/job/:id/download`).
  // That keeps the CSP same-origin only, and means a single reverse-
  // proxy entry covers the whole app.
  //
  // No browser render path uses data: or blob: images — the editor stores
  // same-origin `/uploads/:id/image` URLs, Tiptap's default allowBase64:false
  // rejects pasted data: images, and the data: URLs in icon.tsx/apple-icon.tsx
  // are consumed server-side by Satori. Re-add a scheme here only when a
  // feature actually needs it.
  const imgSrc = ['img-src', "'self'"].join(' ');

  // style-src keeps 'unsafe-inline': Next.js streams inline <style> tags for
  // CSS-in-JS/fonts and React `style=` attributes need style-src-attr
  // 'unsafe-inline' regardless. With script-src locked to nonce +
  // strict-dynamic, style injection alone is not an XSS vector (worst case is
  // exfiltration-via-CSS, which requires an HTML-injection primitive that the
  // script policy already contains). Revisit if Next.js ships nonce'd styles.
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    imgSrc,
    connectSrc,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
}

/**
 * The `/m` PWA: a static Vite bundle served out of `public/m/`, with an
 * HTML shell that carries no nonce.
 *
 * **Why this cannot just reuse the desktop policy.** Under CSP Level 3,
 * `'strict-dynamic'` causes `'self'`, host-sources, and scheme-sources to
 * be *ignored*. Next injects its nonce into its own bootstrap, but a
 * static `index.html` gets none, so its
 * `<script type="module" src="/m/assets/index-<hash>.js">` matches nothing
 * in the policy and is blocked — blank page, one console violation, no
 * other symptom. The same fallback chain would block
 * `navigator.serviceWorker.register()`, so the PWA's offline shell and
 * installability would fail too.
 *
 * **Be honest about the trade.** Dropping `'strict-dynamic'` is a genuine
 * loosening, not a wash: nonce + strict-dynamic trusts only the nonced
 * script and what it transitively loads, whereas bare `'self'` trusts any
 * same-origin script URL. This branch's `script-src` is therefore *weaker*
 * than the desktop's. That is the unavoidable cost of a static bundle with
 * no per-request nonce to inject. What limits it: no inline execution is
 * permitted, and the only same-origin scripts under `/m` are first-party
 * build output with content-hashed filenames.
 *
 * Paired build requirement: Vite must run with
 * `build.modulePreload: { polyfill: false }`. Vite otherwise injects a
 * small *inline* module-preload polyfill that `script-src 'self'`
 * correctly rejects. Do not "fix" that by adding `'unsafe-inline'`.
 */
function mobileDirectives(): string[] {
  return [
    "default-src 'self'",
    // No nonce, no strict-dynamic, and deliberately no 'unsafe-inline'.
    "script-src 'self'",
    // Stated explicitly rather than left to the `child-src → script-src →
    // default-src` fallback chain, where browser behaviour has historically
    // varied. Phase 3 registers a service worker; this is what keeps that
    // from being blocked.
    "worker-src 'self'",
    // `manifest-src` falls back straight to `default-src` ('self'), so this
    // is clarity for the next reader rather than a functional necessity.
    "manifest-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // Exactly 'self' — no blob:, no data:. Phase 0 has no image consumer
    // at all: camera-capture previews (`URL.createObjectURL`) and the MFA
    // enrolment QR both land in Phase 2, and each should widen this with
    // its own changelog entry rather than inheriting a pre-granted scheme.
    "img-src 'self'",
    // Same-origin only. The SPA talks to the API through the existing
    // `/api/[...path]` route handler, which is what lets it reuse the
    // desktop's cookie auth, CSRF, and XFF sanitisation wholesale.
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
}
