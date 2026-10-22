import { All, Controller, ForbiddenException, NotFoundException, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public, SkipCsrf } from '../common/public.decorator.js';
import { SettingsService } from '../settings/settings.service.js';
import { OAuthProviderService } from './oauth-provider.service.js';
import { checkDcrMetadata } from './dcr-metadata.js';
import { isAllowedClientId } from './mcp-oauth.constants.js';

/**
 * A 400 in the same JSON shape as the provider's own `renderError`. Plain
 * Node response methods, so it works on any `ServerResponse`.
 */
function sendOAuthError(res: Response, body: { error: string; error_description: string }): void {
  res.statusCode = 400;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Dynamic client registration; served only in client policy `any`. */
const REGISTRATION_ROUTE = /^\/reg$/;

/**
 * Provider routes this server exposes, relative to `/api/v1/oauth`. Every
 * other route the library has (`jwks`, `userinfo`, registration management,
 * …) is a 404 here, whatever the library configuration says.
 */
const PROVIDER_ROUTES = [
  /^\/auth$/, // authorization endpoint (browser)
  /^\/auth\/[A-Za-z0-9_-]{16,64}$/, // resume after consent (browser)
  /^\/token$/,
  /^\/token\/revocation$/,
  /^\/\.well-known\/openid-configuration$/, // served publicly as RFC 8414 metadata
  REGISTRATION_ROUTE,
];

/**
 * Mounts the OAuth authorization server (`oidc-provider`) under
 * `/api/v1/oauth`. Public by design: the caller is an MCP client (an AI
 * app), authenticated by PKCE and, for clients that publish keys (ChatGPT),
 * a signed client assertion — never by a Weavestream session. CSRF does not
 * apply: no ambient credential authorizes anything here (the browser-facing
 * steps are bound to the provider's own signed interaction cookies). The
 * global `IpRuleGuard` and per-IP throttle still run first.
 */
@Controller({ path: 'oauth', version: '1' })
export class OAuthProviderController {
  constructor(
    private readonly oauth: OAuthProviderService,
    private readonly settings: SettingsService,
  ) {}

  @All('*path')
  @Public()
  @SkipCsrf()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const route = req.path.replace(/^\/api\/v1\/oauth/, '');
    if (!PROVIDER_ROUTES.some((r) => r.test(route))) throw new NotFoundException();

    if (REGISTRATION_ROUTE.test(route)) {
      // Invisible unless any app may connect, as it was before the policy.
      if ((await this.settings.mcpClientPolicy()) !== 'any') throw new NotFoundException();
      if (!(await this.settings.mcpRemoteEnabled())) {
        throw new ForbiddenException('Remote AI connections are turned off on this instance.');
      }
      if (req.method.toUpperCase() !== 'POST') throw new NotFoundException();
      // The JSON body is already parsed (main.ts); the library reads
      // `req.body` when the stream is consumed.
      const checked = checkDcrMetadata(req.body);
      if (!checked.ok) {
        sendOAuthError(res, { error: checked.error, error_description: checked.error_description });
        return;
      }
      req.body = checked.metadata;
    } else if (route === '/auth' && (await this.settings.mcpClientPolicy()) === 'claude_chatgpt') {
      // A client that registered itself while any app could connect is still
      // stored; refuse it here rather than on the consent page. CIMD clients
      // are refused by the provider's own `allowFetch`/`allowClient`.
      // A missing client_id is left to the library's own error.
      const clientId = new URL(req.originalUrl, 'http://local').searchParams.get('client_id');
      if (clientId && !isAllowedClientId(clientId, 'claude_chatgpt')) {
        sendOAuthError(res, { error: 'invalid_client', error_description: 'client is not allowed' });
        return;
      }
    }

    this.oauth.pinPublicOrigin(req.headers);
    // The library routes on `req.url` relative to its mount point; it finds
    // the mount path itself (set explicitly in its middleware).
    const query = req.originalUrl.indexOf('?');
    req.url = route + (query === -1 ? '' : req.originalUrl.slice(query));
    await this.oauth.callback(req, res);
  }
}
