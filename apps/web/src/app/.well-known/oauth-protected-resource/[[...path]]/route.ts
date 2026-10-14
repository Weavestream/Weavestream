import type { NextRequest } from 'next/server';
import { proxyToApi } from '../../../../lib/api-proxy';

// RFC 9728 Protected Resource Metadata for `/mcp`. Clients try the path-
// specific URL (`…/oauth-protected-resource/mcp`) first and the root one
// second; both describe the only protected resource there is.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  if (path && path.join('/') !== 'mcp') {
    return new Response(null, { status: 404 });
  }
  return proxyToApi(req, '/api/v1/mcp/resource-metadata');
}

export { handler as GET };
