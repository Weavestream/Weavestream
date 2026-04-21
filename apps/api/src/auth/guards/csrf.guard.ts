import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
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
