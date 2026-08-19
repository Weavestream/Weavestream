import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { allowedCompanyIds } from '../rbac/permission.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Last visited companies for the signed-in user — the data behind the
 * header scope pill's switcher menu.
 *
 * Server-side and per-user (Redis) rather than browser storage, so
 * the list follows the account: nothing tenant-shaped persists on a
 * shared machine, and a different account on the same browser starts
 * empty. Only company *ids* are stored; names are resolved on every
 * read through the actor's own access scope, so a revoked membership
 * drops the row and a rename is always current.
 *
 * Storage is a JSON array of ids (most recent first) under one key
 * with a sliding TTL — the same blob-with-`EX` shape the step-up and
 * membership caches use. The read-modify-write in `record` is
 * last-write-wins across concurrent tabs; this is a navigation hint,
 * not an invariant, so a lost concurrent visit is acceptable.
 */
@Injectable()
export class RecentCompaniesService {
  private static readonly VERSION = 'v1';
  /**
   * Above the 5 rows the menu shows: the client filters out the
   * company currently being viewed, and the slack keeps the menu full
   * after that filter.
   */
  private static readonly MAX_STORED = 8;
  /** Sliding expiry — an account idle this long starts fresh. */
  private static readonly TTL_SECONDS = 90 * 24 * 60 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  static key(userId: string): string {
    return `user:${userId}:recent-companies:${RecentCompaniesService.VERSION}`;
  }

  async list(
    actor: AuthedUser,
  ): Promise<{ items: { id: string; name: string }[] }> {
    const ids = await this.readIds(actor.id);
    if (ids.length === 0) return { items: [] };

    const allowed = await allowedCompanyIds(this.prisma, actor);
    const visible = allowed === null ? ids : ids.filter((id) => allowed.has(id));
    if (visible.length === 0) return { items: [] };

    const rows = await this.prisma.company.findMany({
      where: { id: { in: visible } },
      select: { id: true, name: true },
    });
    const byId = new Map(rows.map((c) => [c.id, c] as const));
    // Recency order comes from Redis, not from the DB result; a
    // deleted company has no row and silently drops out — same
    // filter-don't-403 policy as the starred feed.
    const items = visible.flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ id: row.id, name: row.name }] : [];
    });
    return { items };
  }

  async record(actor: AuthedUser, companyId: string): Promise<void> {
    // §1: knowing an id is never authorization. The membership check
    // runs before the existence probe, and both failures answer the
    // same 404, so this endpoint cannot be used to test which company
    // ids exist.
    const allowed = await allowedCompanyIds(this.prisma, actor);
    if (allowed !== null && !allowed.has(companyId)) {
      throw new NotFoundException('Company not found');
    }
    const company = await this.prisma.company.findFirst({
      where: { id: companyId },
      select: { id: true },
    });
    if (!company) throw new NotFoundException('Company not found');

    const ids = await this.readIds(actor.id);
    const next = [companyId, ...ids.filter((id) => id !== companyId)].slice(
      0,
      RecentCompaniesService.MAX_STORED,
    );
    await this.redis.client.set(
      RecentCompaniesService.key(actor.id),
      JSON.stringify(next),
      'EX',
      RecentCompaniesService.TTL_SECONDS,
    );
  }

  private async readIds(userId: string): Promise<string[]> {
    const raw = await this.redis.client.get(RecentCompaniesService.key(userId));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((id): id is string => typeof id === 'string')
        .slice(0, RecentCompaniesService.MAX_STORED);
    } catch {
      // A corrupt blob is a cache miss, not an error.
      return [];
    }
  }

}
