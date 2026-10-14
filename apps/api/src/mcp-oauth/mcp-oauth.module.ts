import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { McpConnectionsService } from './mcp-connections.service.js';
import { OAuthProviderService } from './oauth-provider.service.js';
import { OAuthConsentService } from './oauth-consent.service.js';
import { OAuthProviderController } from './oauth-provider.controller.js';
import { OAuthConsentController } from './oauth-consent.controller.js';
import { MeMcpConnectionsController } from './me-mcp-connections.controller.js';
import { AdminMcpConnectionsController } from './admin-mcp-connections.controller.js';

/**
 * The OAuth authorization server for remote MCP clients, the consent step,
 * and connection management. The MCP endpoint itself (`/mcp`) imports this
 * module for token validation.
 */
@Module({
  imports: [SettingsModule],
  controllers: [
    OAuthProviderController,
    OAuthConsentController,
    MeMcpConnectionsController,
    AdminMcpConnectionsController,
  ],
  providers: [McpConnectionsService, OAuthProviderService, OAuthConsentService],
  exports: [McpConnectionsService, OAuthProviderService],
})
export class McpOAuthModule {}
