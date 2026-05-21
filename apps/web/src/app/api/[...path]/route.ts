import type { NextRequest } from 'next/server';
import { proxyToApi } from '../../../lib/api-proxy';

// Reverse-proxy every `/api/*` browser request through to the API,
// sanitizing client-IP headers on the way through. Replaces the
// previous `next.config.js` `rewrites()` rule, which was a blind
// passthrough that let inbound `X-Forwarded-For` flow straight to
// Express — see `apps/web/src/lib/api-proxy.ts` for the rationale.

// Streamed responses (chat SSE, large file downloads) and streamed
// requests (uploads) both work through this handler — the proxy keeps
// the body as a ReadableStream end-to-end and only touches headers.
export const dynamic = 'force-dynamic';
// Use the Node runtime so streaming `fetch` with `duplex: 'half'` is
// available; the Edge runtime's `fetch` does not currently accept a
// streaming request body.
export const runtime = 'nodejs';

async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  const subpath = (path ?? []).map(encodeURIComponent).join('/');
  return proxyToApi(req, `/api/${subpath}`);
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as OPTIONS,
  handler as HEAD,
};
