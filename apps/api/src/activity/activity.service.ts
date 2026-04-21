import { ForbiddenException, Injectable } from '@nestjs/common';
import { requireTenantContext } from '@weavestream/shared/server';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export interface RecentActivityItem {
  type: 'asset' | 'article';
  id: string;
  name: string;
  companyId: string;
  companyName: string;
  companySlug: string;
  updatedAt: string;
  updatedByName: string | null;
}

/**
 * Phase 9b.3 — "Recent activity" feed for the operator home dashboard.
 *
 * Deliberately narrow: we merge the most recently updated Assets and
 * Articles in the caller's tenant scope and return them sorted by
 * `updatedAt`. No audit-log trawling, no delete/create signals — the
 * widget exists to answer "what has changed?" without reproducing the
 * dedicated Audit page.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async recent(
    actor: AuthedUser,
    limit: number,
  ): Promise<{ items: RecentActivityItem[] }> {
    // The widget is an operator-only affordance. Clients have their
    // own portal and shouldn't see cross-company activity anyway.
    if (actor.role === 'CLIENT_USER') {
      throw new ForbiddenException();
    }
    const safeLimit = Math.min(Math.max(limit, 1), 25);
    const ctx = requireTenantContext();

    // SUPER_ADMIN is global; everyone else is restricted to their
    // non-revoked membership companies. An operator role with zero
    // memberships simply gets an empty feed.
    const scope: { companyId?: { in: string[] } } = {};
    if (!ctx.isSuperAdmin) {
      if (ctx.allowedCompanyIds.length === 0) {
        return { items: [] };
      }
      scope.companyId = { in: ctx.allowedCompanyIds };
    }

    // Fetch `limit` of each source; merging and re-sorting is fine at
    // this size. Archived rows are excluded — a stale archived item
    // bubbling to the top of "recent activity" is more noise than
    // signal.
    const [assets, articles] = await Promise.all([
      this.prisma.asset.findMany({
        where: { ...scope, archivedAt: null },
        orderBy: { updatedAt: 'desc' },
        take: safeLimit,
        select: {
          id: true,
          name: true,
          companyId: true,
          updatedAt: true,
          updatedBy: true,
        },
      }),
      this.prisma.article.findMany({
        where: { ...scope, archivedAt: null },
        orderBy: { updatedAt: 'desc' },
        take: safeLimit,
        select: {
          id: true,
          title: true,
          companyId: true,
          updatedAt: true,
          updatedBy: true,
        },
      }),
    ]);

    const companyIds = new Set<string>();
    const userIds = new Set<string>();
    for (const a of assets) {
      companyIds.add(a.companyId);
      if (a.updatedBy) userIds.add(a.updatedBy);
    }
    for (const a of articles) {
      companyIds.add(a.companyId);
      if (a.updatedBy) userIds.add(a.updatedBy);
    }

    const [companies, users] = await Promise.all([
      companyIds.size
        ? this.prisma.company.findMany({
            where: { id: { in: [...companyIds] } },
            select: { id: true, name: true, slug: true },
          })
        : Promise.resolve([] as Array<{ id: string; name: string; slug: string }>),
      userIds.size
        ? this.prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);

    const companyById = new Map(companies.map((c) => [c.id, c]));
    const userById = new Map(users.map((u) => [u.id, u]));

    const items: RecentActivityItem[] = [];
    for (const a of assets) {
      const c = companyById.get(a.companyId);
      if (!c) continue;
      items.push({
        type: 'asset',
        id: a.id,
        name: a.name,
        companyId: a.companyId,
        companyName: c.name,
        companySlug: c.slug,
        updatedAt: a.updatedAt.toISOString(),
        updatedByName: a.updatedBy ? userById.get(a.updatedBy)?.name ?? null : null,
      });
    }
    for (const a of articles) {
      const c = companyById.get(a.companyId);
      if (!c) continue;
      items.push({
        type: 'article',
        id: a.id,
        name: a.title,
        companyId: a.companyId,
        companyName: c.name,
        companySlug: c.slug,
        updatedAt: a.updatedAt.toISOString(),
        updatedByName: a.updatedBy ? userById.get(a.updatedBy)?.name ?? null : null,
      });
    }

    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { items: items.slice(0, safeLimit) };
  }
}
