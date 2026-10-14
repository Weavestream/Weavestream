import type { NextRequest } from 'next/server';
import { proxyToApi } from '../../lib/api-proxy';

// The remote MCP endpoint (Streamable HTTP) for ChatGPT and Claude. The API
// authenticates it with an OAuth access token; this only forwards. POST is
// the protocol; GET and DELETE reach the API so it can answer 405.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handler(req: NextRequest): Promise<Response> {
  return proxyToApi(req, '/api/v1/mcp');
}

export { handler as POST, handler as GET, handler as DELETE };
