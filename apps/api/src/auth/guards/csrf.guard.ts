import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthedUser } from '../../common/current-user.decorator.js';
import { SKIP_CSRF_KEY } from '../../common/public.decorator.js';
import { CsrfService } from '../csrf.service.js';
import { EnvService } from '../../config/env.service.js';
import { cookieNames } from '../cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly csrf: CsrfService,
    private readonly env: EnvService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    // CSRF defends *ambient* credentials: a cookie the browser attaches to a
    // cross-site request without the caller's involvement. A bearer token is
    // not ambient — an attacker's page cannot make the victim's browser send
    // it — so the double-submit check has nothing to protect here and would
    // only make every programmatic client fetch a token it cannot use.
    // Keyed off the principal AuthGuard already established, never off a
    // client-supplied header (CLAUDE.md §1).
    if ((req as Request & { user?: AuthedUser }).user?.apiKeyId) return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (skip) return true;

    const header = req.headers['x-csrf-token'];
    const headerToken = Array.isArray(header) ? header[0] : header;
    const cookieToken = req.cookies[cookieNames(this.env).csrf] as string | undefined;

    if (!this.csrf.match(headerToken, cookieToken)) {
      throw new ForbiddenException('CSRF token mismatch');
    }
    return true;
  }
}
