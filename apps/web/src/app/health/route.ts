import type { NextRequest } from 'next/server';
import { proxyToApi } from '../../lib/api-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handler(req: NextRequest): Promise<Response> {
  return proxyToApi(req, '/health');
}

export { handler as GET, handler as HEAD };
