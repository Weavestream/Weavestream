import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectThrottlerStorage, type ThrottlerStorage } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { EnvService } from '../config/env.service.js';
import { ipOf, userAgentOf } from '../common/request-meta.js';
import { McpConnectionsService } from '../mcp-oauth/mcp-connections.service.js';
import { OAuthProviderService } from '../mcp-oauth/oauth-provider.service.js';
import { connectionAllowed, MCP_SCOPE } from '../mcp-oauth/mcp-oauth.constants.js';
import type { McpRequest } from './mcp-principal.js';

const MINUTE_MS = 60_000;
/** Failed tokens per client IP per minute; well above any honest retry. */
const FAILED_TOKENS_PER_MIN = 30;

/** The RFC 9728 metadata URL for the `/mcp` resource. */
export function resourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource/mcp`;
}

/**
 * Authenticates `POST /mcp` with an OAuth access token issued by this
 * server's authorization server, and nothing else: not a session cookie, not
 * an API key, not a token for another audience.
 *
 * On every request it re-checks what can change after the token was issued:
 * the connection is live, the user is active and MFA-enrolled, remote
 * connections are switched on, and the client policy still allows the app.
 * So a revocation, a deactivation, the switch or a narrowed policy stops the
 * next request, not the next token.
 *
 * Rate limits are its own, because the global throttler runs before any
 * controller guard and would key `/mcp` on the client IP — one provider
 * egress IP shared by every user of that AI app. A failed token counts per
 * IP in a small bucket; a valid one counts per user at the global limit. So
 * a stranger replaying junk tokens from Claude's network cannot lock out the
 * instance's real Claude users.
 */
@Injectable()
export class McpAccessTokenGuard implements CanActivate {
  constructor(
    private readonly oauth: OAuthProviderService,
    private readonly connections: McpConnectionsService,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly env: EnvService,
    @InjectThrottlerStorage() private readonly throttle: ThrottlerStorage,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<McpRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const ip = ipOf(req);

    // Every refusal counts against the client IP, whatever the reason (no
    // token, a malformed or unknown one, a foreign Origin, the switch off):
    // `/mcp` skips the global throttler, so this bucket is its only limit
    // before a token is proven. Only a valid token moves on to the per-user
    // bucket below.
    let principal: Awaited<ReturnType<typeof this.authenticate>>;
    try {
      principal = await this.authenticate(req, res);
    } catch (err) {
      await this.count(res, `mcp-fail:${ip}`, FAILED_TOKENS_PER_MIN);
      throw err;
    }
    await this.count(res, `mcp-user:${principal.userId}`, this.env.values.GLOBAL_RATE_LIMIT_PER_MIN);

    req.mcp = { ...principal, ip, userAgent: userAgentOf(req) };
    return true;
  }

  /** The connection behind this request, or an exception explaining the refusal. */
  private async authenticate(req: McpRequest, res: Response) {
    // Streamable HTTP: a browser page on another origin must not drive this
    // endpoint (DNS rebinding). Server-side clients send no Origin at all.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== this.oauth.issuer) {
      throw new ForbiddenException('Origin not allowed.');
    }

    const token = bearerOf(req.headers.authorization);
    if (!token) this.challenge(res, false);

    if (!(await this.settings.mcpRemoteEnabled())) {
      throw new ForbiddenException('Remote AI connections are turned off on this instance.');
    }

    const principal = await this.resolve(token);
    if (!principal) this.challenge(res, true);
    return principal;
  }

  private async resolve(token: string) {
    let at;
    try {
      at = await this.oauth.provider.AccessToken.find(token);
    } catch {
      // A malformed value is not a token; it gets the same 401 as an unknown one.
      return null;
    }
    // Expired tokens are not found. The audience must be this resource
    // (RFC 8707): a token minted for anything else is not accepted here.
    if (!at || at.aud !== this.oauth.resource || !at.grantId || !at.accountId) return null;
    if (!String(at.scope ?? '').split(' ').includes(MCP_SCOPE)) return null;

    const connection = await this.connections.findActiveByGrant(at.grantId);
    if (!connection || connection.userId !== at.accountId) return null;
    // Refused, not revoked: widening the policy again restores it.
    if (!connectionAllowed(await this.settings.mcpClientPolicy(), connection)) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: connection.userId },
      select: { isActive: true, mfaEnforcementCompletedAt: true },
    });
    if (!user?.isActive || user.mfaEnforcementCompletedAt === null) return null;

    this.connections.touch(connection);
    return { connectionId: connection.id, userId: connection.userId, allowWrite: connection.allowWrite };
  }

  /**
   * Count one hit; over the limit is a 429 with a `Retry-After` header (the
   * bucket's remaining lifetime, at least 1 s). A challenge header set for
   * the refusal being counted is dropped: the client must wait, not sign in.
   */
  private async count(res: Response, key: string, limit: number): Promise<void> {
    const hit = await this.throttle.increment(key, MINUTE_MS, limit, 0, 'mcp');
    if (hit.totalHits <= limit) return;
    const retryAfter = Math.max(1, Math.ceil(hit.timeToExpire / 1000));
    res.removeHeader('WWW-Authenticate');
    res.setHeader('Retry-After', String(retryAfter));
    throw new HttpException(
      { message: 'Too many requests.', retryAfterSeconds: retryAfter },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * 401 with the RFC 9728 pointer, so a client discovers where to authorize.
   * `error="invalid_token"` only when a token was presented (RFC 6750 §3.1).
   */
  private challenge(res: Response, presented: boolean): never {
    const parts = [
      `resource_metadata="${resourceMetadataUrl(this.oauth.issuer)}"`,
      `scope="${MCP_SCOPE}"`,
      ...(presented ? ['error="invalid_token"'] : []),
    ];
    res.setHeader('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
    throw new UnauthorizedException();
  }
}

/** Header only; a token in the query string is never accepted. */
function bearerOf(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const value = rest.join(' ').trim();
  return value.length > 0 && value.length <= 512 ? value : undefined;
}
