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
import { RedisService } from '../../redis/redis.service.js';
import { MembershipCacheService } from '../../cache/membership-cache.service.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';

const MEMBERSHIP_CACHE_SEC = 60;

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser; id?: string }>();
    if (!req.user) return next.handle();

    const allowedCompanyIds = await this.loadAllowedCompanyIds(req.user.id);

    const tenant: TenantContext = {
      userId: req.user.id,
      role: req.user.role,
      email: req.user.email,
      allowedCompanyIds,
      isSuperAdmin: req.user.role === 'SUPER_ADMIN',
      requestId: (req.id as string | undefined) ?? 'unknown',
      ip: req.ip ?? '0.0.0.0',
      userAgent: (req.headers['user-agent'] ?? 'unknown').toString(),
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

  private async loadAllowedCompanyIds(userId: string): Promise<string[]> {
    const key = MembershipCacheService.key(userId);
    const cached = await this.redis.client.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as string[];
      } catch {
        // fall through and refetch
      }
    }
    const now = new Date();
    const rows = await this.prisma.membership.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { companyId: true },
    });
    const ids = rows.map((r) => r.companyId);
    await this.redis.client.set(key, JSON.stringify(ids), 'EX', MEMBERSHIP_CACHE_SEC);
    return ids;
  }
}
