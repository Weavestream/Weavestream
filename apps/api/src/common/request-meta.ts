import type { Request } from 'express';

export type RequestMeta = { ip: string; userAgent: string };

export function requestMetaOf(req: Request): RequestMeta {
  return { ip: ipOf(req), userAgent: uaOf(req) };
}

function ipOf(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? '0.0.0.0';
}

function uaOf(req: Request): string {
  return (req.headers['user-agent'] ?? 'unknown').toString().slice(0, 500);
}
