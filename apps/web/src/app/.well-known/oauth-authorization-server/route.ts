import type { NextRequest } from 'next/server';
import { proxyToApi } from '../../../lib/api-proxy';

// RFC 8414 metadata for the remote MCP authorization server. The API serves
// it from the provider's discovery route with the OpenID-only fields
// removed; Weavestream is not an OpenID Provider.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handler(req: NextRequest): Promise<Response> {
  return proxyToApi(req, '/api/v1/oauth/.well-known/openid-configuration');
}

export { handler as GET };
