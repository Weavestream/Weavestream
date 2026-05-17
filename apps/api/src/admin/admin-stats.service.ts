import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Aggregate totals shown on the admin dashboard's "At a glance" panel.
 * Each value is a non-negative integer counting active (non-archived,
 * non-deactivated) rows across the entire platform.
 *
 * The endpoint is gated to SUPER_ADMIN and OPERATORs with non-NONE
 * `globalAccess` (see `AdminStatsController`). For those roles the
 * tenant middleware grants a read bypass, so a `where: { archivedAt:
 * null }` count without a `companyId` filter is safe.
 */
export interface AdminStats {
  companies: number;
  users: number;
  assets: number;
  passwords: number;
  articles: number;
  domains: number;
}

@Injectable()
export class AdminStatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Six parallel `count` queries — cheaper than fetching list pages
   * and intrinsically accurate (the previous dashboard was capping
   * the company / user lists at `limit=200` and silently truncating
   * past that). All counts exclude archived/deactivated rows so the
   * tile values represent live working surface area.
   */
  async getAll(): Promise<AdminStats> {
    const [companies, users, assets, passwords, articles, domains] =
      await Promise.all([
        this.prisma.company.count({ where: { archivedAt: null } }),
        this.prisma.user.count({ where: { isActive: true } }),
        this.prisma.asset.count({ where: { archivedAt: null } }),
        this.prisma.password.count({ where: { archivedAt: null } }),
        this.prisma.article.count({ where: { archivedAt: null } }),
        this.prisma.monitoredDomain.count({ where: { archivedAt: null } }),
      ]);
    return { companies, users, assets, passwords, articles, domains };
  }
}
