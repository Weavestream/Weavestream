import type { NextRequest } from 'next/server';
import { INTERNAL_TOKEN_HEADER } from '@weavestream/shared';
// Import the proxy/edge-safe config module directly rather than the
// `server-api` re-export, so this module stays free of `next/headers` and
// friends (keeps it unit-testable and light).
import { API_INTERNAL_URL } from './api-config';
import {
  INBOUND_XFF_HEADER,
  RESOLVED_CLIENT_IP_HEADER,
  UNKNOWN_CLIENT_IP,
  getResolvedClientIp,
} from './client-ip';
import { isInternalOnlyUpstreamUrl } from './internal-only-paths';

// The one endpoint allowed to receive the display-only raw inbound XFF
// header. Every other `/api/*` call strips it (see HOP_BY_HOP_HEADERS)
// so an untrusted, client-influenced value never reaches a handler that
// might act on it.
const INBOUND_XFF_DIAGNOSTIC_PATH = '/api/v1/security/whoami';

// Reverse-proxy an inbound browser request through to the API,
// rewriting client-IP-bearing headers to a single sanitized entry so
// an internet attacker can't spoof `X-Forwarded-For` through the web
// tier. Replaces the previous `next.config.js` `rewrites()` block,
// which had no hook for header surgery and would have forwarded the
// raw inbound chain straight to Express.
//
// The resolved client IP comes from `proxy.ts` (via the
// `x-ws-resolved-client-ip` request header), which applied
// `TRUST_PROXY_HOPS` to the inbound chain before any handler ran.
// Falling back to `getResolvedClientIp` here keeps the proxy correct
// even if `proxy.ts` is ever skipped for a path.

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // `host` would otherwise pin the request to the inbound vhost; let
  // `fetch` derive it from the upstream URL.
  'host',
  // The resolved-IP header is an internal marker — never forward it
  // upstream; the API only ever sees the sanitized `x-forwarded-for`.
  RESOLVED_CLIENT_IP_HEADER,
  // The raw inbound XFF is a display-only diagnostic marker. Strip it by
  // default and re-add it (below) only for the whoami endpoint, so its
  // untrusted value can't reach any other handler.
  INBOUND_XFF_HEADER,
  // The internal-API token is a web→API credential minted server-side by
  // the ip-rules poller. A browser-supplied value must NEVER transit the
  // proxy, or a client could smuggle it toward a peer-gated internal
  // endpoint. Strip it unconditionally here. (WS-028)
  INTERNAL_TOKEN_HEADER,
]);

// RFC 7807 problem+json 404, mirroring the API's ProblemExceptionFilter so
// a denied internal path is indistinguishable from a genuinely-absent one.
// `instance` is the PUBLIC request path only — never the internal upstream
// URL, so `http://api:4000/...` is never disclosed to the client.
function internalOnlyNotFound(req: NextRequest): Response {
  const body = JSON.stringify({
    type: 'https://weavestream.app/problems/404',
    title: 'Not Found',
    status: 404,
    instance: `${req.nextUrl.pathname}${req.nextUrl.search ?? ''}`,
  });
  return new Response(body, {
    status: 404,
    headers: { 'content-type': 'application/problem+json' },
  });
}

export async function proxyToApi(
  req: NextRequest,
  upstreamPath: string,
): Promise<Response> {
  const search = req.nextUrl.search ?? '';
  const url = `${API_INTERNAL_URL}${upstreamPath}${search}`;

  // Deny internal-only endpoints before any header work or upstream fetch.
  // Checks the final constructed URL (after undici-equivalent path
  // normalization) so `..` traversal from either the `/api/*` or the
  // `/health/*` catch-all can't reach a peer-gated route. (WS-028)
  if (isInternalOnlyUpstreamUrl(url)) {
    return internalOnlyNotFound(req);
  }

  const outgoing = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === 'x-forwarded-for') continue;
    if (key.toLowerCase() === 'x-real-ip') continue;
    if (key.toLowerCase() === 'x-forwarded-host') continue;
    if (key.toLowerCase() === 'x-forwarded-proto') continue;
    outgoing.set(key, value);
  }

  const resolvedIp = getResolvedClientIp(req.headers) || UNKNOWN_CLIENT_IP;
  outgoing.set('x-forwarded-for', resolvedIp);
  outgoing.set('x-forwarded-host', req.nextUrl.host);
  outgoing.set(
    'x-forwarded-proto',
    req.nextUrl.protocol.replace(':', '') || 'http',
  );

  // Only the admin whoami diagnostic receives the raw inbound XFF (set by
  // `proxy.ts`, already length-bounded). It is echoed back for the "what
  // you presented vs. what we resolved" comparison and never used for
  // attribution. Every other endpoint had it stripped above.
  if (upstreamPath === INBOUND_XFF_DIAGNOSTIC_PATH) {
    outgoing.set(INBOUND_XFF_HEADER, req.headers.get(INBOUND_XFF_HEADER) ?? '');
  }

  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: outgoing,
    redirect: 'manual',
    // Stream the inbound body through so file uploads and SSE-style
    // chunked POSTs don't get buffered. `duplex: 'half'` is required
    // by `undici` whenever the body is a ReadableStream.
    body: hasBody ? req.body : undefined,
    duplex: hasBody ? 'half' : undefined,
  };

  const upstream = await fetch(url, init);

  // Pass response headers through unchanged except for hop-by-hop
  // markers, which would confuse the browser if relayed.
  //
  // `content-encoding` / `content-length` MUST be dropped: undici (the
  // runtime `fetch`) transparently decompresses a `Content-Encoding:
  // gzip|br|deflate` response, so `upstream.body` is already the
  // *decoded* byte stream — but `upstream.headers` still advertises the
  // original encoding and the original (compressed) length. Relaying
  // either makes the browser try to gunzip plain bytes, which fails with
  // `ERR_CONTENT_DECODING_FAILED` ("cannot decode raw data") and aborts
  // the body read. Because the API only compresses responses past a size
  // threshold, this silently corrupted just the larger JSON payloads
  // (e.g. `/me/stars`, relation lists) while small ones slipped through.
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === 'content-encoding' || lower === 'content-length') return;
    responseHeaders.append(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
