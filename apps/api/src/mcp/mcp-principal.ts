import type { Request } from 'express';

/**
 * Who a `/mcp` request acts as, set by `McpAccessTokenGuard` from a validated
 * OAuth access token. Deliberately not `req.user`: `/mcp` is the transport,
 * and the API-key guards (HTTP-method read-only rule included) apply to each
 * tool's own REST call instead, where the method is the real operation.
 */
export interface McpPrincipal {
  connectionId: string;
  userId: string;
  allowWrite: boolean;
  /** Resolved client IP of the `/mcp` request; forwarded to each tool call. */
  ip: string;
  userAgent: string;
}

export type McpRequest = Request & { mcp?: McpPrincipal };
