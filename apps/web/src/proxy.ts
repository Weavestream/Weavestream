import { NextResponse, type NextRequest } from 'next/server';
import { matchIpRule } from '@weavestream/shared';
import {
  INBOUND_XFF_HEADER,
  RESOLVED_CLIENT_IP_HEADER,
  UNKNOWN_CLIENT_IP,
  boundInboundXff,
  normalizeClientIp,
  resolveClientIpFromXff,
} from './lib/client-ip';
import { getActiveIpRules } from './lib/ip-rules-cache';
import {
  ACCESS_COOKIE_NAME,
  API_INTERNAL_URL,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from './lib/api-config';

/**
 * CSP + security headers. Strict by default; no 'unsafe-eval' in production.
 * Inline scripts are allowed only via a per-request nonce, which Next.js
 * automatically applies to its own bootstrap when it sees `strict-dynamic`.
 *
 * Runs at the edge-runtime proxy layer (Next.js 16+ renamed this convention
 * from `middleware.ts` to `proxy.ts` — same API, clearer name).
 */
export async function proxy(req: NextRequest) {
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
  // Stash the *raw* inbound chain (length-bounded) under a dedicated
  // display-only header for the admin `whoami` diagnostic. `set`
  // overwrites, so any value a client tried to inject under this name
  // is discarded and replaced with what the edge actually presented.
  // `api-proxy.ts` strips this from every upstream call except
  // `/api/v1/security/whoami`, and it is never trusted for attribution.
  requestHeaders.set(INBOUND_XFF_HEADER, boundInboundXff(inboundXff));

  // Mirror the API's `IpRuleGuard` at the page-render layer so a DENY
  // rule blocks HTML responses too — not just API calls. Without this,
  // a banned IP would still see `/login` and could be confused into
  // thinking the block isn't working. Fail-open is intentional and
  // matches the guard: a broken API shouldn't lock everyone out of the
  // login page.
  const rules = await getActiveIpRules();
  const ipRuleHit = matchIpRule(resolvedClientIp, rules);
  if (ipRuleHit?.action === 'DENY') {
    return new NextResponse('Access denied by IP rule', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const preflightSetCookies = await refreshAccessCookieForProtectedPage(
    req,
    requestHeaders,
    resolvedClientIp,
  );

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  for (const setCookie of preflightSetCookies) {
    res.headers.append('set-cookie', setCookie);
  }
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

async function refreshAccessCookieForProtectedPage(
  req: NextRequest,
  requestHeaders: Headers,
  resolvedClientIp: string,
): Promise<string[]> {
  if (!shouldPreflightAuth(req)) return [];
  if (!req.cookies.has(SESSION_COOKIE_NAME) || req.cookies.has(ACCESS_COOKIE_NAME)) {
    return [];
  }

  let cookieHeader = requestHeaders.get('cookie') ?? '';
  let csrfToken = req.cookies.get(CSRF_COOKIE_NAME)?.value;
  const setCookies: string[] = [];

  if (!csrfToken) {
    const csrfRes = await fetch(`${API_INTERNAL_URL}/api/v1/auth/csrf`, {
      method: 'POST',
      headers: refreshHeaders(req, cookieHeader, resolvedClientIp),
      cache: 'no-store',
    }).catch(() => null);

    if (!csrfRes?.ok) return [];
    const issuedCookies = getSetCookieHeaders(csrfRes.headers);
    setCookies.push(...issuedCookies);
    cookieHeader = mergeSetCookiesIntoCookieHeader(cookieHeader, issuedCookies);
    requestHeaders.set('cookie', cookieHeader);
    csrfToken = extractCookieValue(cookieHeader, CSRF_COOKIE_NAME);
    if (!csrfToken) return setCookies;
  }

  const refreshRes = await fetch(`${API_INTERNAL_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: refreshHeaders(req, cookieHeader, resolvedClientIp, csrfToken),
    cache: 'no-store',
  }).catch(() => null);

  if (!refreshRes) return setCookies;
  const refreshCookies = getSetCookieHeaders(refreshRes.headers);
  setCookies.push(...refreshCookies);
  if (refreshCookies.length > 0) {
    cookieHeader = mergeSetCookiesIntoCookieHeader(cookieHeader, refreshCookies);
    requestHeaders.set('cookie', cookieHeader);
  }
  return setCookies;
}

/**
 * Which page routes get an access-cookie preflight refresh before they
 * render. This allowlist is COUPLED to `server-api.ts`, which strips the
 * long-lived refresh cookie from every SSR read: once the short-lived
 * access cookie expires, an authenticated route that is NOT listed here
 * gets no fresh access cookie and no refresh-cookie fallback, so its SSR
 * `/me` fetch 401s and `getMe()` returns null → the layout bounces the
 * user to `/login` even though their session is still valid. Every
 * authenticated top-level route MUST appear below; add new ones here.
 */
function shouldPreflightAuth(req: NextRequest): boolean {
  const { pathname } = req.nextUrl;
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/setup/') ||
    pathname.startsWith('/mfa/')
  ) {
    return false;
  }
  return (
    pathname === '/' ||
    pathname === '/access-pending' ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/me' ||
    pathname.startsWith('/me/') ||
    pathname.startsWith('/portal/')
  );
}

function refreshHeaders(
  req: NextRequest,
  cookieHeader: string,
  resolvedClientIp: string,
  csrfToken?: string,
): Headers {
  const headers = new Headers({
    accept: 'application/json',
    cookie: cookieHeader,
  });
  headers.set('x-forwarded-for', resolvedClientIp);
  headers.set('x-forwarded-host', req.nextUrl.host);
  headers.set(
    'x-forwarded-proto',
    req.nextUrl.protocol.replace(':', '') || 'http',
  );
  const userAgent = req.headers.get('user-agent');
  if (userAgent) headers.set('user-agent', userAgent);
  if (csrfToken) headers.set('x-csrf-token', csrfToken);
  return headers;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetter.getSetCookie?.();
  if (values && values.length > 0) return values;
  const combined = headers.get('set-cookie');
  return combined ? splitSetCookieHeader(combined) : [];
}

function splitSetCookieHeader(header: string): string[] {
  return header.split(/,(?=\s*[^;,]+=)/).map((v) => v.trim()).filter(Boolean);
}

function mergeSetCookiesIntoCookieHeader(
  cookieHeader: string,
  setCookies: string[],
): string {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    cookies.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
  }

  for (const setCookie of setCookies) {
    const pair = setCookie.split(';', 1)[0]?.trim();
    if (!pair) continue;
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    if (isCookieDeletion(setCookie, value)) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }

  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Whether a Set-Cookie clears the cookie rather than setting it. Express's
 * `clearCookie` emits an empty value; belt-and-suspenders we also treat any
 * non-positive `Max-Age` as a deletion (whitespace-tolerant, so `Max-Age=0`,
 * `Max-Age= 0 `, and `Max-Age=-1` all count) in case the upstream cookie
 * serialization ever changes.
 */
function isCookieDeletion(setCookie: string, value: string): boolean {
  if (value === '') return true;
  const maxAge = /;\s*max-age\s*=\s*(-?\d+)/i.exec(setCookie);
  return maxAge !== null && Number(maxAge[1]) <= 0;
}

function extractCookieValue(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    return trimmed.slice(name.length + 1);
  }
  return undefined;
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
