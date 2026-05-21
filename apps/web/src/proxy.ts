import { NextResponse, type NextRequest } from 'next/server';
import {
  RESOLVED_CLIENT_IP_HEADER,
  UNKNOWN_CLIENT_IP,
  normalizeClientIp,
  resolveClientIpFromXff,
} from './lib/client-ip';

/**
 * CSP + security headers. Strict by default; no 'unsafe-eval' in production.
 * Inline scripts are allowed only via a per-request nonce, which Next.js
 * automatically applies to its own bootstrap when it sees `strict-dynamic`.
 *
 * Runs at the edge-runtime proxy layer (Next.js 16+ renamed this convention
 * from `middleware.ts` to `proxy.ts` — same API, clearer name).
 */
export function proxy(req: NextRequest) {
  const nonce = cryptoRandomNonce();
  // HSTS + upgrade-insecure-requests only make sense when the current request
  // was actually HTTPS. On plain http://localhost:3000 both would force the
  // browser to try TLS on a port that isn't serving it.
  // Trust the proto from the request; behind a reverse proxy that terminates
  // TLS, Next populates req.nextUrl.protocol from the forwarded headers.
  const isHttps =
    req.nextUrl.protocol === 'https:' ||
    req.headers.get('x-forwarded-proto') === 'https';

  // Next.js dev server (webpack HMR + React Refresh) relies on eval() to
  // hot-swap modules. Permit it in development only; production CSP stays
  // strict (nonce + strict-dynamic, no unsafe-eval).
  const isDev = process.env.NODE_ENV !== 'production';
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  // Every thumbnail, attachment, logo, and export PDF is streamed
  // through the API (`/uploads/:id/image`, `/export/job/:id/download`).
  // That keeps the CSP same-origin only, and means a single reverse-
  // proxy entry covers the whole app.

  // Dev also needs websocket access for HMR; production keeps connect-src tight.
  const connectSrc = [
    'connect-src',
    "'self'",
    ...(isDev ? ['ws:', 'wss:'] : []),
  ].join(' ');

  const imgSrc = ['img-src', "'self'", 'data:', 'blob:'].join(' ');

  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'", // Tailwind/Next.js inject inline styles
    imgSrc,
    connectSrc,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(isHttps ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);

  // Resolve the real client IP from inbound `X-Forwarded-For` using
  // `TRUST_PROXY_HOPS` (number of edge proxies in front of this web
  // container) and stash it on the request headers so downstream
  // handlers — the `/api/[...path]` route handler proxy and any SSR
  // fetch through `server-api.ts` — can forward a single sanitized
  // entry to the API instead of letting an attacker-controlled chain
  // flow through. We also overwrite `x-forwarded-for` / `x-real-ip`
  // on the propagated request headers so any downstream code that
  // forgets to use the resolved header can't be tricked.
  const inboundXff =
    req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip');
  const resolvedClientIp = normalizeClientIp(
    resolveClientIpFromXff(inboundXff) ?? UNKNOWN_CLIENT_IP,
  );
  requestHeaders.set(RESOLVED_CLIENT_IP_HEADER, resolvedClientIp);
  requestHeaders.set('x-forwarded-for', resolvedClientIp);
  requestHeaders.delete('x-real-ip');

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('Content-Security-Policy', csp);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );
  if (isHttps) {
    res.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }

  // Remember the portal tenant the client most recently viewed. The
  // root landing route and /me's layout both consult this cookie to
  // keep multi-membership clients in context instead of dumping them
  // onto a neutral profile page. Pure navigation hint — never trusted
  // for authorization.
  const portalMatch = req.nextUrl.pathname.match(/^\/portal\/([^/]+)/);
  if (portalMatch) {
    const slug = portalMatch[1]!;
    if (req.cookies.get(LAST_COMPANY_COOKIE)?.value !== slug) {
      res.cookies.set(LAST_COMPANY_COOKIE, slug, {
        path: '/',
        sameSite: 'lax',
        maxAge: ONE_YEAR_SECONDS,
        secure: isHttps,
      });
    }
  }

  return res;
}

const LAST_COMPANY_COOKIE = 'ws_last_company';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function cryptoRandomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

export const config = {
  // Skip the entire `_next/*` tree so Next.js internal traffic (HMR
  // WebSocket at `_next/webpack-hmr`, React Server Components stream at
  // `_next/rsc`, static assets) never touches the proxy. Running the
  // proxy over the HMR upgrade request is what produces the
  // "WebSocket is closed due to suspension" warnings on page
  // navigation in Safari / WebKit.
  matcher: ['/((?!_next/|favicon.ico).*)'],
};
