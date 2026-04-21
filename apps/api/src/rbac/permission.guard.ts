import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  IS_PUBLIC_KEY,
  MFA_SETUP_ALLOWED_KEY,
} from '../common/public.decorator.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import {
  AUTHED_ONLY_KEY,
  REQUIRE_PERMISSION_KEY,
  type CompanyIdSource,
  type RequirePermissionMetadata,
} from './require-permission.decorator.js';
import { PermissionService } from './permission.service.js';

@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly log = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const mfaSetupAllowed = this.reflector.getAllAndOverride<boolean>(
      MFA_SETUP_ALLOWED_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    // During MFA setup the user is authenticated but permission checks
    // would be premature — the only allowed routes are the enrollment
    // ones and are always scope='self' in spirit.
    if (mfaSetupAllowed) return true;

    const authedOnly = this.reflector.getAllAndOverride<boolean>(AUTHED_ONLY_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (authedOnly) return true;

    const meta = this.reflector.getAllAndOverride<RequirePermissionMetadata | undefined>(
      REQUIRE_PERMISSION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );

    if (!meta) {
      // Default deny: any route must declare its permission requirement.
      this.log.error(
        `Missing @RequirePermission on ${ctx.getClass().name}.${ctx.getHandler().name}`,
      );
      throw new ForbiddenException('Route is missing a permission declaration');
    }

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const user = req.user;
    if (!user) {
      // AuthGuard should have rejected already.
      throw new ForbiddenException('Unauthenticated');
    }

    const companyId = meta.companyIdFrom
      ? await this.resolveCompanyId(req, meta.companyIdFrom)
      : undefined;

    const decision = await this.permissions.can(user, meta.action, { companyId });
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason ?? 'Forbidden');
    }
    return true;
  }

  private async resolveCompanyId(
    req: Request,
    source: CompanyIdSource,
  ): Promise<string | undefined> {
    if (typeof source === 'function') {
      return source(req);
    }
    switch (source) {
      case 'params.id':
        return (req.params as Record<string, string | undefined>).id;
      case 'params.companyId':
        return (req.params as Record<string, string | undefined>).companyId;
      case 'body.companyId':
        return (req.body as Record<string, string | undefined> | undefined)?.companyId;
      case 'query.companyId':
        return (req.query as Record<string, string | undefined>).companyId;
    }
  }
}
