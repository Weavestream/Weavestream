import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../rbac/permission.service.js';

/**
 * Read-only audit log. SUPER_ADMIN sees everything; OPERATOR_FULL of a
 * company sees entries scoped to that company (must pass companyId
 * query param). Other roles are 403.
 *
 * Phase 9a: entries now include `before`/`after` payloads and
 * bulk-resolved `entityName` + `companyName` strings so the admin UI
 * can render "AssetField · Hostname · on Server layout" style labels
 * without issuing a second round of requests per row.
 */
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  @AuthedOnly()
  async list(
    @CurrentUser() actor: AuthedUser,
    @Query('companyId') companyId?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (actor.role !== 'SUPER_ADMIN') {
      if (!companyId) {
        throw new ForbiddenException('companyId is required for non-admin audit reads');
      }
      const decision = await this.permissions.can(actor, 'audit.read', { companyId });
      if (!decision.allowed) throw new ForbiddenException(decision.reason);
    }

    const where: Record<string, unknown> = {};
    if (companyId) where.companyId = companyId;
    if (action) where.action = { startsWith: action };
    if (actorId) where.actorId = actorId;
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }

    const select = {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      companyId: true,
      actorId: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      before: true,
      after: true,
      actor: { select: { id: true, email: true, name: true } },
    } as const;

    // Cursor path (back-compat for any existing callers). Preserves
    // the old `take + 1 / hasMore` trick and does not compute total.
    if (cursor) {
      const take = Math.min(Math.max(limit ? parseInt(limit, 10) : 100, 1), 500);
      const rows = await this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        cursor: { id: cursor },
        skip: 1,
        select,
      });
      const hasMore = rows.length > take;
      const slice = hasMore ? rows.slice(0, take) : rows;
      const [entityNames, companyNames] = await Promise.all([
        resolveEntityNames(this.prisma, slice),
        resolveCompanyNames(this.prisma, slice),
      ]);
      return {
        items: slice.map((row) => ({
          ...row,
          entityName:
            row.entityType && row.entityId
              ? (entityNames.get(`${row.entityType}:${row.entityId}`) ??
                fallbackEntityName(row))
              : null,
          companyName: row.companyId ? (companyNames.get(row.companyId) ?? null) : null,
        })),
        total: null,
        page: null,
        pageSize: take,
        nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
      };
    }

    // Offset path. `page` is 1-based. `pageSize` defaults to 50 and is
    // clamped to [1, 200].
    const parsedSize = pageSize ? parseInt(pageSize, 10) : 50;
    const take = Math.min(
      Math.max(Number.isFinite(parsedSize) ? parsedSize : 50, 1),
      200,
    );
    const parsedPage = page ? parseInt(page, 10) : 1;
    const safePage = Math.max(Number.isFinite(parsedPage) ? parsedPage : 1, 1);

    const total = await this.prisma.auditLog.count({ where });
    const totalPages = Math.max(Math.ceil(total / take), 1);
    const clampedPage = Math.min(safePage, totalPages);
    const skip = (clampedPage - 1) * take;

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      select,
    });

    const [entityNames, companyNames] = await Promise.all([
      resolveEntityNames(this.prisma, rows),
      resolveCompanyNames(this.prisma, rows),
    ]);

    return {
      items: rows.map((row) => ({
        ...row,
        entityName:
          row.entityType && row.entityId
            ? (entityNames.get(`${row.entityType}:${row.entityId}`) ??
              fallbackEntityName(row))
            : null,
        companyName: row.companyId ? (companyNames.get(row.companyId) ?? null) : null,
      })),
      total,
      page: clampedPage,
      pageSize: take,
      nextCursor: null,
    };
  }
}

type AuditRow = {
  entityType: string | null;
  entityId: string | null;
  companyId: string | null;
  before: unknown;
  after: unknown;
};

/**
 * Bulk-resolve human-readable names for entity references. Groups by
 * entity type so we issue at most one query per model rather than one
 * per row. Unknown entity types are silently ignored — the UI falls
 * back to the raw id when a name isn't available.
 */
async function resolveEntityNames(
  prisma: PrismaService,
  rows: AuditRow[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byType = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.entityType || !r.entityId) continue;
    if (!byType.has(r.entityType)) byType.set(r.entityType, new Set());
    byType.get(r.entityType)!.add(r.entityId);
  }

  for (const [type, idSet] of byType) {
    const ids = Array.from(idSet);
    const loader = ENTITY_NAME_LOADERS[type];
    if (!loader) continue;
    try {
      const entries = await loader(prisma, ids);
      for (const [id, name] of entries) {
        out.set(`${type}:${id}`, name);
      }
    } catch {
      // Swallow — audit reads should never 500 because a lookup query
      // failed. The UI falls back to the raw id.
    }
  }
  return out;
}

type NameLoader = (prisma: PrismaService, ids: string[]) => Promise<Array<[string, string]>>;

const ENTITY_NAME_LOADERS: Record<string, NameLoader> = {
  Company: async (prisma, ids) =>
    (await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map(
      (r) => [r.id, r.name] as [string, string],
    ),
  User: async (prisma, ids) =>
    (await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })).map(
      (r) => [r.id, r.name || r.email] as [string, string],
    ),
  Asset: async (prisma, ids) =>
    (await prisma.asset.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map(
      (r) => [r.id, r.name] as [string, string],
    ),
  AssetLayout: async (prisma, ids) =>
    (await prisma.assetLayout.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map(
      (r) => [r.id, r.name] as [string, string],
    ),
  AssetField: async (prisma, ids) =>
    (await prisma.assetField.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map(
      (r) => [r.id, r.name] as [string, string],
    ),
  Article: async (prisma, ids) =>
    (await prisma.article.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } })).map(
      (r) => [r.id, r.title] as [string, string],
    ),
  Folder: async (prisma, ids) =>
    (await prisma.folder.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map(
      (r) => [r.id, r.name] as [string, string],
    ),
  Membership: async (prisma, ids) =>
    (
      await prisma.membership.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          role: true,
          user: { select: { email: true, name: true } },
        },
      })
    ).map(
      (r) => [r.id, `${r.user.name || r.user.email} · ${r.role}`] as [string, string],
    ),
  MonitoredDomain: async (prisma, ids) =>
    (await prisma.monitoredDomain.findMany({ where: { id: { in: ids } }, select: { id: true, hostname: true } })).map(
      (r) => [r.id, r.hostname] as [string, string],
    ),
  Upload: async (prisma, ids) =>
    (await prisma.upload.findMany({ where: { id: { in: ids } }, select: { id: true, filename: true } })).map(
      (r) => [r.id, r.filename] as [string, string],
    ),
  Password: async (prisma, ids) =>
    (
      await prisma.password.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, username: true },
      })
    ).map(
      (r) =>
        [r.id, r.username ? `${r.name} · ${r.username}` : r.name] as [string, string],
    ),
  PasswordFolder: async (prisma, ids) =>
    (
      await prisma.passwordFolder.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    ).map((r) => [r.id, r.name] as [string, string]),
};

async function resolveCompanyNames(
  prisma: PrismaService,
  rows: AuditRow[],
): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(rows.map((r) => r.companyId).filter((id): id is string => Boolean(id))),
  );
  if (ids.length === 0) return new Map();
  const companies = await prisma.company.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(companies.map((c) => [c.id, c.name] as [string, string]));
}

/**
 * Fall back to any embedded name we can find in the audit payload.
 * Writes produced by the Phase 9a `logChange` helpers stash the
 * entity's display name into the `after.*Name` / `before.*Name` keys,
 * so a row without a live DB match (e.g. the entity was later
 * deleted) still shows something useful in the UI.
 */
function fallbackEntityName(row: AuditRow): string | null {
  const hay = [row.after, row.before];
  const candidateKeys = [
    'fieldName',
    'layoutName',
    'name',
    'title',
    'hostname',
    'filename',
    'slug',
  ];
  for (const blob of hay) {
    if (!blob || typeof blob !== 'object') continue;
    const obj = blob as Record<string, unknown>;
    for (const key of candidateKeys) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}
