import { All, Controller, HttpCode, HttpStatus, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from '@weavestream/shared/mcp-tools';
import { Public, SkipCsrf } from '../common/public.decorator.js';
import { McpAccessTokenGuard } from './mcp-access-token.guard.js';
import { McpDelegationService } from './mcp-delegation.service.js';
import { internalToolApi, MCP_INTERNAL_ORIGIN } from './internal-tool-api.js';
import type { McpRequest } from './mcp-principal.js';

/**
 * The remote MCP endpoint (`/mcp` publicly, proxied by web), Streamable HTTP
 * in stateless JSON mode.
 *
 * Every request builds its own MCP server and transport, bound to the one
 * connection its token resolved to, and throws them away afterwards. There
 * is no MCP session, no `Mcp-Session-Id`, and no server-side "current
 * customer": each tool call names its company explicitly, and concurrent
 * requests share nothing but the handle store, which is keyed by random
 * handles.
 *
 * `@Public()` only skips the cookie/API-key `AuthGuard`; the route-level
 * `McpAccessTokenGuard` authenticates instead. `@SkipThrottle` skips the
 * global per-IP bucket, which that guard replaces (see its comment).
 */
@Controller({ path: 'mcp', version: '1' })
export class McpController {
  constructor(
    private readonly delegation: McpDelegationService,
    @Inject(MCP_INTERNAL_ORIGIN) private readonly internalOrigin: string,
  ) {}

  @Post()
  @Public()
  @SkipCsrf()
  @SkipThrottle({ global: true })
  @UseGuards(McpAccessTokenGuard)
  async handle(@Req() req: McpRequest, @Res() res: Response): Promise<void> {
    const principal = req.mcp!;
    const server = new McpServer({ name: 'weavestream', version: '1.0.0' });
    // A read-only connection never registers a write tool: not listed, not
    // callable. The REST layer refuses its writes as well (HTTP-method rule
    // on the connection's grant), so this is not the only check.
    registerTools(server, internalToolApi(this.delegation, this.internalOrigin, principal), {
      allowWrite: principal.allowWrite,
      credential: 'connection',
    });
    // Stateless (no session id) and JSON responses: the global
    // `compression()` would buffer an SSE stream.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // Express has already read the body; hand it over parsed.
    await transport.handleRequest(req, res, req.body);
  }

  /** No server-initiated stream and no session to delete in stateless mode. */
  @All()
  @Public()
  @SkipCsrf()
  @HttpCode(HttpStatus.METHOD_NOT_ALLOWED)
  notAllowed(@Res({ passthrough: true }) res: Response): { message: string } {
    res.setHeader('Allow', 'POST');
    return { message: 'Method not allowed.' };
  }
}
