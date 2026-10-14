import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/public.decorator.js';
import { OAuthProviderService } from '../mcp-oauth/oauth-provider.service.js';
import { MCP_SCOPE } from '../mcp-oauth/mcp-oauth.constants.js';

/**
 * RFC 9728 Protected Resource Metadata for `/mcp`, served publicly at
 * `/.well-known/oauth-protected-resource/mcp` (and the root variant) by web.
 * Its own controller, so no token guard can ever apply to it: a client reads
 * it before it has any token.
 */
@Controller({ path: 'mcp/resource-metadata', version: '1' })
export class McpMetadataController {
  constructor(private readonly oauth: OAuthProviderService) {}

  @Get()
  @Public()
  metadata() {
    return {
      // Must equal the URL the user typed into Claude or ChatGPT.
      resource: this.oauth.resource,
      authorization_servers: [this.oauth.issuer],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Weavestream',
    };
  }
}
