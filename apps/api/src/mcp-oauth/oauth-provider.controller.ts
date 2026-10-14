import { All, Controller, NotFoundException, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public, SkipCsrf } from '../common/public.decorator.js';
import { OAuthProviderService } from './oauth-provider.service.js';

/**
 * Provider routes this server exposes, relative to `/api/v1/oauth`. Every
 * other route the library has (`jwks`, `userinfo`, registration, …) is a 404
 * here, whatever the library configuration says.
 */
const PROVIDER_ROUTES = [
  /^\/auth$/, // authorization endpoint (browser)
  /^\/auth\/[A-Za-z0-9_-]{16,64}$/, // resume after consent (browser)
  /^\/token$/,
  /^\/token\/revocation$/,
  /^\/\.well-known\/openid-configuration$/, // served publicly as RFC 8414 metadata
];

/**
 * Mounts the OAuth authorization server (`oidc-provider`) under
 * `/api/v1/oauth`. Public by design: the caller is an MCP client (ChatGPT,
 * Claude), authenticated by PKCE and, for ChatGPT, a signed client
 * assertion — never by a Weavestream session. CSRF does not apply: no
 * ambient credential authorizes anything here (the browser-facing steps are
 * bound to the provider's own signed interaction cookies). The global
 * `IpRuleGuard` and per-IP throttle still run first.
 */
@Controller({ path: 'oauth', version: '1' })
export class OAuthProviderController {
  constructor(private readonly oauth: OAuthProviderService) {}

  @All('*path')
  @Public()
  @SkipCsrf()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const route = req.path.replace(/^\/api\/v1\/oauth/, '');
    if (!PROVIDER_ROUTES.some((r) => r.test(route))) throw new NotFoundException();
    this.oauth.pinPublicOrigin(req.headers);
    // The library routes on `req.url` relative to its mount point; it finds
    // the mount path itself (set explicitly in its middleware).
    const query = req.originalUrl.indexOf('?');
    req.url = route + (query === -1 ? '' : req.originalUrl.slice(query));
    await this.oauth.callback(req, res);
  }
}
