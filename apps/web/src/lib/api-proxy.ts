import type { NextRequest } from 'next/server';
import { API_INTERNAL_URL } from './server-api';
import {
  RESOLVED_CLIENT_IP_HEADER,
  UNKNOWN_CLIENT_IP,
  getResolvedClientIp,
} from './client-ip';

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
]);

export async function proxyToApi(
  req: NextRequest,
  upstreamPath: string,
): Promise<Response> {
  const search = req.nextUrl.search ?? '';
  const url = `${API_INTERNAL_URL}${upstreamPath}${search}`;

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
  // markers, which would confuse the browser if relayed. Content-
  // length is fine to keep since we stream the same bytes.
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    responseHeaders.append(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
