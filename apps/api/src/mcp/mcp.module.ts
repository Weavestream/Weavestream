import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { McpOAuthModule } from '../mcp-oauth/mcp-oauth.module.js';
import { INTERNAL_LISTENER_ORIGIN } from '../common/internal-listener.js';
import { McpController } from './mcp.controller.js';
import { McpMetadataController } from './mcp-metadata.controller.js';
import { McpAccessTokenGuard } from './mcp-access-token.guard.js';
import { McpDelegationService } from './mcp-delegation.service.js';
import { MCP_INTERNAL_ORIGIN } from './internal-tool-api.js';

/**
 * The remote MCP endpoint. `McpDelegationService` is exported because
 * `AuthGuard` (an app-wide guard) redeems its handles on the internal
 * listener.
 */
@Module({
  imports: [SettingsModule, McpOAuthModule],
  // The metadata route is registered first so `GET mcp/resource-metadata`
  // is never caught by the 405 handler on `mcp`.
  controllers: [McpMetadataController, McpController],
  providers: [
    McpDelegationService,
    McpAccessTokenGuard,
    { provide: MCP_INTERNAL_ORIGIN, useValue: INTERNAL_LISTENER_ORIGIN },
  ],
  exports: [McpDelegationService],
})
export class McpModule {}
