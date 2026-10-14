import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpConsentDetails, McpConsentResult } from '@weavestream/shared';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { SettingsService } from '../settings/settings.service.js';
import { McpConnectionsService } from './mcp-connections.service.js';
import { OAuthProviderService } from './oauth-provider.service.js';
import { areAllowedRedirects, isAllowedClientId, MCP_SCOPE, TTL } from './mcp-oauth.constants.js';

type Meta = { ip: string; userAgent: string };

const EXPIRED_REQUEST =
  'This connection request has expired or was started in another browser. Start the connection again from your AI app.';

/**
 * The consent step of the OAuth flow, on the Weavestream side.
 *
 * The browser that started the authorization holds the provider's signed
 * interaction cookie, scoped to `/api/v1/oauth-consent/<uid>`. Every call
 * here reads the interaction through that cookie, so a consent link opened
 * in another browser (a session-swap attempt) finds nothing.
 *
 * The caller is a normal Weavestream session (login + MFA, and a step-up to
 * approve). This service never authenticates anyone itself.
 */
@Injectable()
export class OAuthConsentService {
  constructor(
    private readonly oauth: OAuthProviderService,
    private readonly connections: McpConnectionsService,
    private readonly settings: SettingsService,
  ) {}

  async details(
    actor: AuthedUser,
    uid: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<McpConsentDetails> {
    const pending = await this.load(uid, req, res);
    return {
      uid,
      clientId: pending.clientId,
      clientHost: new URL(pending.clientId).hostname,
      clientName: pending.clientName,
      redirectHost: pending.redirectHost,
      user: { email: actor.email },
    };
  }

  /**
   * Create the grant and the connection, then hand the interaction back to
   * the provider. A failure after the grant is saved leaves a grant with no
   * connection, which can never yield a token (`findAccount` requires a live
   * connection).
   */
  async approve(
    actor: AuthedUser,
    uid: string,
    allowWrite: boolean,
    req: IncomingMessage,
    res: ServerResponse,
    meta: Meta,
  ): Promise<McpConsentResult> {
    const pending = await this.load(uid, req, res);
    const { provider, resource } = this.oauth;

    const grant = new provider.Grant({ accountId: actor.id, clientId: pending.clientId });
    // `mcp` is both a scope the library knows and the resource server's
    // scope; the grant must carry both or consent is asked for again.
    grant.addOIDCScope(MCP_SCOPE);
    grant.addResourceScope(resource, MCP_SCOPE);
    const grantId = await grant.save();

    await this.connections.create(
      actor,
      {
        clientId: pending.clientId,
        clientName: pending.clientName,
        redirectHost: pending.redirectHost,
        grantId,
        allowWrite,
        expiresAt: new Date(Date.now() + TTL.grant * 1000),
      },
      meta,
    );

    const redirectTo = await provider.interactionResult(
      req,
      res,
      { login: { accountId: actor.id }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );
    return { redirectTo };
  }

  async deny(uid: string, req: IncomingMessage, res: ServerResponse): Promise<McpConsentResult> {
    await this.load(uid, req, res);
    const redirectTo = await this.oauth.provider.interactionResult(
      req,
      res,
      { error: 'access_denied', error_description: 'The user declined the connection.' },
      { mergeWithLastSubmission: false },
    );
    return { redirectTo };
  }

  /** The pending authorization this browser started, re-checked against policy. */
  private async load(uid: string, req: IncomingMessage, res: ServerResponse) {
    if (!(await this.settings.mcpRemoteEnabled())) {
      throw new ForbiddenException('Remote AI connections are turned off on this instance.');
    }
    this.oauth.pinPublicOrigin(req.headers);
    let details: Awaited<ReturnType<typeof this.oauth.provider.interactionDetails>>;
    try {
      details = await this.oauth.provider.interactionDetails(req, res);
    } catch {
      // No interaction cookie, or the interaction expired: both mean this
      // browser has nothing pending. The library's error says which, and
      // neither is worth more than this message to the user.
      throw new BadRequestException(EXPIRED_REQUEST);
    }
    if (details.uid !== uid || !['login', 'consent'].includes(details.prompt.name)) {
      throw new BadRequestException(EXPIRED_REQUEST);
    }

    // The provider already enforced all of this when the request arrived;
    // re-checked here because this is where a person is asked to trust it.
    const clientId = String(details.params.client_id ?? '');
    const redirectUri = String(details.params.redirect_uri ?? '');
    const requested = details.params.resource;
    if (
      !isAllowedClientId(clientId) ||
      !areAllowedRedirects([redirectUri]) ||
      (requested !== undefined && requested !== this.oauth.resource)
    ) {
      throw new BadRequestException(EXPIRED_REQUEST);
    }
    const client = await this.oauth.provider.Client.find(clientId);
    if (!client || !client.redirectUris?.includes(redirectUri)) {
      throw new BadRequestException(EXPIRED_REQUEST);
    }
    return {
      clientId,
      clientName: (client.clientName ?? '').trim().slice(0, 100) || new URL(clientId).hostname,
      redirectHost: new URL(redirectUri).hostname,
    };
  }
}
