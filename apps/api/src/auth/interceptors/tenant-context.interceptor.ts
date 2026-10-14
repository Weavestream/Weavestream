import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { runWithTenantContext, type TenantContext } from '@weavestream/shared/server';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MembershipCacheService } from '../../cache/membership-cache.service.js';
import { isProgrammatic, type AuthedUser } from '../../common/current-user.decorator.js';
import { ipOf, userAgentOf } from '../../common/request-meta.js';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: MembershipCacheService,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser; id?: string }>();
    if (!req.user) return next.handle();

    const allowedCompanyIds = await this.loadAllowedCompanyIds(
      req.user.id,
      isProgrammatic(req.user),
    );

    const tenant: TenantContext = {
      userId: req.user.id,
      role: req.user.role,
      email: req.user.email,
      allowedCompanyIds,
      isSuperAdmin: req.user.role === 'SUPER_ADMIN',
      globalAccess: req.user.globalAccess,
      requestId: (req.id as string | undefined) ?? 'unknown',
      apiKeyId: req.user.apiKeyId,
      mcpConnectionId: req.user.mcpConnectionId,
      ip: ipOf(req),
      userAgent: userAgentOf(req),
    };

    return new Observable((subscriber) => {
      runWithTenantContext(tenant, () => {
        next.handle().subscribe({
          next: (v) => subscriber.next(v),
          error: (e) => subscriber.error(e),
          complete: () => subscriber.complete(),
        });
      });
    });
  }

  /**
   * `fresh` (programmatic principals) skips the cache entirely, so an API
   * key or MCP connection sees a membership revocation on its very next
   * request. Interactive sessions use the generation-checked cache, which
   * never serves rows loaded before the last `invalidate`.
   */
  private async loadAllowedCompanyIds(userId: string, fresh: boolean): Promise<string[]> {
    return this.cache.readThrough(
      userId,
      MembershipCacheService.key(userId),
      async () => {
        const rows = await this.prisma.membership.findMany({
          where: {
            userId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { companyId: true },
        });
        return rows.map((r) => r.companyId);
      },
      { fresh },
    );
  }
}
