import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  INTERNAL_TOKEN_HEADER,
  deriveInternalApiToken,
} from '@weavestream/shared';
import { EnvService } from '../config/env.service.js';
import { isPrivatePeer } from './request-meta.js';

/**
 * Guards internal-only endpoints — routes the web container polls but no
 * browser may reach (e.g. `GET /api/v1/ip-rules/active`).
 *
 * Two layers, both required:
 *   1. The TCP peer must be an internal address (`isPrivatePeer`).
 *   2. A valid `x-ws-internal-token` derived from `COOKIE_SIGNING_KEY`.
 *
 * The peer check alone stopped being a boundary once the web tier became a
 * blind reverse proxy on the same bridge: a proxied internet request has
 * the web container as its socket peer, so it passes layer 1. The derived
 * token is the fix — a browser cannot forge it, and the web proxy strips
 * any inbound `x-ws-internal-token` before forwarding, so it can never be
 * smuggled through. The web tier's first-line defense is a 404 on this
 * path before it forwards; this guard is defense-in-depth. (WS-028)
 *
 * The token is derived from an already-required secret, so there is no new
 * env var to set and the check is always enforceable.
 */
@Injectable()
export class InternalOnlyGuard implements CanActivate {
  private readonly log = new Logger(InternalOnlyGuard.name);
  private expectedToken: Promise<string> | null = null;

  constructor(private readonly env: EnvService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();

    if (!isPrivatePeer(req.socket.remoteAddress)) {
      throw new ForbiddenException();
    }

    // Reject arrays (duplicate headers) and empty/missing values outright.
    const presented = req.headers[INTERNAL_TOKEN_HEADER];
    if (typeof presented !== 'string' || presented.length === 0) {
      this.log.warn(
        'Internal endpoint denied: missing internal token from private peer',
      );
      throw new ForbiddenException();
    }

    // Constant-time compare (length check first — timingSafeEqual throws on
    // unequal-length buffers). Never log the expected or presented value.
    const expected = await this.getExpectedToken();
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.log.warn(
        'Internal endpoint denied: internal token mismatch — web/api COOKIE_SIGNING_KEY out of sync?',
      );
      throw new ForbiddenException();
    }

    return true;
  }

  private getExpectedToken(): Promise<string> {
    // Derive once per guard instance; COOKIE_SIGNING_KEY is fixed for the
    // process lifetime.
    if (!this.expectedToken) {
      this.expectedToken = deriveInternalApiToken(
        this.env.values.COOKIE_SIGNING_KEY,
      );
    }
    return this.expectedToken;
  }
}
