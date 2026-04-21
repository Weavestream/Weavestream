import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthedUser } from '../common/current-user.decorator.js';
import {
  REQUIRE_PERMISSION_KEY,
  type CompanyIdSource,
  type RequirePermissionMetadata,
} from './require-permission.decorator.js';
import { PermissionService } from './permission.service.js';

/**
 * Defense-in-depth: even if a permission rule permits a CONTRACTOR read,
 * a CONTRACTOR with an expired membership must hit 403 on every
 * company-scoped route, unconditionally. The main PermissionService
 * already enforces this through the cache, but this guard is a direct
 * per-request DB-backed check for the narrow CONTRACTOR case so a
 * stale cache cannot leak access to an expired contractor.
 */
@Injectable()
export class ContractorAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    const user = req.user;
    if (!user || user.role !== 'CONTRACTOR') return true;

    const meta = this.reflector.getAllAndOverride<RequirePermissionMetadata | undefined>(
      REQUIRE_PERMISSION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!meta || !meta.companyIdFrom) return true;

    const companyId = await this.resolveCompanyId(req, meta.companyIdFrom);
    if (!companyId) return true;

    const memberships = await this.permissions.loadMemberships(user.id);
    const now = new Date();
    const match = memberships.find(
      (m) =>
        m.companyId === companyId &&
        m.revokedAt === null &&
        (m.expiresAt === null || m.expiresAt > now),
    );
    if (!match) {
      throw new ForbiddenException('Contractor membership is expired or revoked');
    }
    return true;
  }

  private async resolveCompanyId(
    req: Request,
    source: CompanyIdSource,
  ): Promise<string | undefined> {
    if (typeof source === 'function') return source(req);
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
