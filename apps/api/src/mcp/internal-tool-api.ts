import { HttpToolApi } from '@weavestream/shared/mcp-tools';
import type { McpDelegationService } from './mcp-delegation.service.js';
import type { McpPrincipal } from './mcp-principal.js';

/** Injection token for the internal listener's origin (tests use their own). */
export const MCP_INTERNAL_ORIGIN = Symbol('MCP_INTERNAL_ORIGIN');

/**
 * The catalogue's `ToolApi` for one `/mcp` request: each tool call is one
 * REST call to the internal listener, carrying a fresh single-use handle
 * bound to this connection, the call's method and its path. The resolved
 * client IP and user agent travel along (loopback is a trusted proxy), so
 * IP rules, rate limits and audit see the real client.
 */
export function internalToolApi(
  delegation: McpDelegationService,
  origin: string,
  principal: McpPrincipal,
): HttpToolApi {
  return new HttpToolApi({
    baseUrl: origin,
    credential: 'connection',
    authorize: ({ method, url }) => {
      const handle = delegation.mint({
        connectionId: principal.connectionId,
        userId: principal.userId,
        method,
        path: url.pathname,
      });
      return {
        headers: {
          authorization: `Bearer ${handle}`,
          'x-forwarded-for': principal.ip,
          'user-agent': principal.userAgent,
        },
        done: () => delegation.release(handle),
      };
    },
  });
}
