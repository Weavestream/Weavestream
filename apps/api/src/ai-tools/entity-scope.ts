import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Scope-safe entity → company resolution for ids that came from an
 * untrusted source (an LLM tool call).
 *
 * The Prisma tenant middleware (`assertTenantScope`) rejects any read
 * of a tenant-scoped model that carries no `companyId` filter unless
 * the actor has a read bypass (SUPER_ADMIN / globalAccess FULL or
 * READONLY). So "load the row to learn its company" must be phrased
 * differently per scope:
 *
 *  - read-bypass actors query by id alone (the middleware permits it);
 *  - membership-scoped actors query with
 *    `companyId: { in: allowedCompanyIds }` — which both satisfies the
 *    middleware and pins resolution to their own tenants, so an
 *    out-of-scope id resolves to "not found" rather than leaking that
 *    it exists;
 *  - an empty membership list short-circuits to `null` WITHOUT
 *    querying: `{ in: [] }` extracts to zero scope candidates and the
 *    middleware would throw.
 *
 * Resolution is NEVER authorization — every caller must still run
 * `PermissionService.can` against the resolved company.
 */
export function hasGlobalReadScope(ctx: TenantContext): boolean {
  return (
    ctx.isSuperAdmin ||
    ctx.globalAccess === 'FULL' ||
    ctx.globalAccess === 'READONLY'
  );
}

/**
 * The WHERE clause for a scope-safe single-row lookup, or `null` when
 * the actor has no scope at all (resolve to not-found, don't query).
 */
export function scopedCompanyLookupWhere(
  ctx: TenantContext,
  id: string,
): { id: string } | { id: string; companyId: { in: string[] } } | null {
  if (hasGlobalReadScope(ctx)) return { id };
  if (ctx.allowedCompanyIds.length === 0) return null;
  return { id, companyId: { in: ctx.allowedCompanyIds } };
}

export type ScopedEntityKind = 'asset' | 'article' | 'password';

@Injectable()
export class EntityScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the company an entity belongs to, visible only within the
   * actor's tenant scope. Returns `null` for not-found AND for
   * out-of-scope — callers must not distinguish the two toward the
   * model (non-enumeration).
   */
  async resolveEntityCompany(
    ctx: TenantContext,
    kind: ScopedEntityKind,
    id: string,
  ): Promise<string | null> {
    const where = scopedCompanyLookupWhere(ctx, id);
    if (where === null) return null;
    const select = { companyId: true } as const;
    let row: { companyId: string } | null;
    switch (kind) {
      case 'asset':
        row = await this.prisma.asset.findFirst({ where, select });
        break;
      case 'article':
        row = await this.prisma.article.findFirst({ where, select });
        break;
      case 'password':
        row = await this.prisma.password.findFirst({ where, select });
        break;
    }
    return row?.companyId ?? null;
  }
}
