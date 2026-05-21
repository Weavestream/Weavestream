import type { NextRequest } from 'next/server';
import { proxyToApi } from '../../../lib/api-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  const subpath = (path ?? []).map(encodeURIComponent).join('/');
  return proxyToApi(req, `/health/${subpath}`);
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
