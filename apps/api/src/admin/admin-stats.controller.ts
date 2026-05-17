import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { AdminStatsService, type AdminStats } from './admin-stats.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';

/**
 * Cross-tenant totals for the admin dashboard's "At a glance" panel.
 *
 * Visibility model — mirrors `CompaniesService.list`:
 *   - SUPER_ADMIN                                       → allowed
 *   - OPERATOR with `globalAccess` FULL or READONLY     → allowed
 *   - Everyone else (CONTRACTOR, CLIENT_USER, OPERATOR
 *     with NONE globalAccess + only platform capabilities)
 *                                                       → 403
 *
 * The dashboard layout already gates the entire `/admin` tree to
 * operators (`canAccessAdminShell`), so the only role that can hit
 * this endpoint and be rejected is an OPERATOR with NONE globalAccess
 * but a non-empty `platformCapabilities`. For that operator the panel
 * silently degrades to dashes on the web side — we don't leak counts
 * for companies they can't see, and we don't gum up the page with a
 * red error banner.
 *
 * No `companyId` filter is needed inside the service because the
 * tenant middleware's read-bypass clause kicks in for both roles
 * permitted above (see `prisma/tenant-scoped-models.ts`).
 */
@Controller({ path: 'admin/stats', version: '1' })
export class AdminStatsController {
  constructor(private readonly stats: AdminStatsService) {}

  @Get()
  @AuthedOnly()
  async get(@CurrentUser() actor: AuthedUser): Promise<AdminStats> {
    if (!isGlobalAdminViewer(actor)) {
      throw new ForbiddenException(
        'admin-stats endpoint requires SUPER_ADMIN or an OPERATOR with non-NONE globalAccess',
      );
    }
    return this.stats.getAll();
  }
}

function isGlobalAdminViewer(actor: AuthedUser): boolean {
  if (actor.role === 'SUPER_ADMIN') return true;
  if (actor.role !== 'OPERATOR') return false;
  return actor.globalAccess === 'FULL' || actor.globalAccess === 'READONLY';
}
