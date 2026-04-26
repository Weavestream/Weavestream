import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { MinioService } from '../storage/minio.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Phase 9b.3 — per-user "Starred" entities (companies, passwords, assets, articles).
 *
 * Stars are independent of Membership: a SUPER_ADMIN may star any
 * entity, while everyone else may only star an entity they already
 * hold a non-revoked membership on. That keeps the client-portal
 * tenant isolation story unchanged — a CLIENT_USER cannot surface
 * entities they otherwise can't see just by starring one.
 */

export type EntityType = 'company' | 'password' | 'asset' | 'article';

const ENTITY_TYPE_TO_API_NAME: Record<EntityType, string> = {
  company: 'company',
  password: 'password',
  asset: 'asset',
  article: 'article',
};

const STAR_COMPANY_SELECT = {
  id: true,
  name: true,
  slug: true,
  archivedAt: true,
  type: true,
  city: true,
  region: true,
  country: true,
  website: true,
  updatedAt: true,
  logoUploadId: true,
  logoUpload: {
    select: {
      id: true,
      storageKey: true,
      thumbnailKey: true,
      mimeType: true,
      sizeBytes: true,
      companyId: true,
      createdAt: true,
    },
  },
  _count: { select: { memberships: { where: { revokedAt: null } } } },
} as const;

/**
 * Shape of an individual item in the unified `GET /me/stars` response.
 * Discriminated by `type` so the frontend can render each with the
 * right icon, link, and sub-line — while keeping a single
 * starredAt-sorted list that reads well as a dashboard panel.
 */
export type StarredItem =
  | {
      type: 'company';
      id: string;
      name: string;
      slug: string;
      archivedAt: string | null;
      starredAt: string;
      companyId: string;
      companyName: string;
      memberCount: number;
      logo: {
        uploadId: string;
        url: string | null;
        thumbnailUrl: string | null;
        mimeType: string;
        sizeBytes: number;
        uploadedAt: string;
      } | null;
    }
  | {
      type: 'password';
      id: string;
      name: string;
      archivedAt: string | null;
      starredAt: string;
      companyId: string;
      companyName: string;
      companyArchivedAt: string | null;
    }
  | {
      type: 'asset';
      id: string;
      name: string;
      archivedAt: string | null;
      starredAt: string;
      companyId: string;
      companyName: string;
      companyArchivedAt: string | null;
      layoutName: string | null;
      layoutIcon: string | null;
    }
  | {
      type: 'article';
      id: string;
      name: string;
      slug: string;
      archivedAt: string | null;
      starredAt: string;
      companyId: string;
      companyName: string;
      companyArchivedAt: string | null;
    };

@Injectable()
export class StarsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly minio: MinioService,
  ) {}

  /**
   * Unified "Starred" feed for the dashboard. Returns a single
   * starredAt-desc-sorted list mixing all four entity types so the
   * frontend can render a simple, pin-board-style panel.
   *
   * Access model: items on companies where the actor no longer has an
   * active membership are silently filtered out — we don't delete the
   * underlying star row (so re-adding the user to the company brings
   * the pin back), but we don't leak names either. SUPER_ADMIN bypasses
   * the membership filter.
   */
  async list(actor: AuthedUser): Promise<{ items: StarredItem[] }> {
    const allowedCompanyIds = await this.getAllowedCompanyIds(actor);

    // Short-circuit: a non-super-admin with zero memberships has
    // nothing to see. Skip every query.
    if (allowedCompanyIds !== null && allowedCompanyIds.size === 0) {
      return { items: [] };
    }

    // Non-null `allowedCompanyIds` means "filter to these companies";
    // `null` means "no filter" (super-admin).
    const companyIds = allowedCompanyIds === null ? null : [...allowedCompanyIds];

    // The Asset and Article Prisma models expose `companyId` as a
    // scalar only (no `company` back-relation), so we fetch rows with
    // scalar fields here and resolve company names in a single batch
    // query below. Password has a proper relation so we could nest,
    // but we keep the same pattern for symmetry and a simpler type
    // inference story.
    const [companyRows, passwordRows, assetRows, articleRows] = await Promise.all([
      this.prisma.starredCompany.findMany({
        where: {
          userId: actor.id,
          ...(companyIds === null ? {} : { companyId: { in: companyIds } }),
        },
        orderBy: { createdAt: 'desc' },
        select: {
          createdAt: true,
          company: { select: STAR_COMPANY_SELECT },
        },
      }),
      this.prisma.starredPassword.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: 'desc' },
        select: {
          createdAt: true,
          password: {
            select: {
              id: true,
              name: true,
              archivedAt: true,
              companyId: true,
            },
          },
        },
      }),
      this.prisma.starredAsset.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: 'desc' },
        select: {
          createdAt: true,
          asset: {
            select: {
              id: true,
              name: true,
              archivedAt: true,
              companyId: true,
              assetLayout: { select: { name: true, icon: true } },
            },
          },
        },
      }),
      this.prisma.starredArticle.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: 'desc' },
        select: {
          createdAt: true,
          article: {
            select: {
              id: true,
              title: true,
              slug: true,
              archivedAt: true,
              companyId: true,
            },
          },
        },
      }),
    ]);

    // Apply the access filter in memory — we did it server-side for
    // companies (where `companyId` is a Prisma column on the join
    // table), but for nested entities the model shape forces us to
    // filter here. With `allowedCompanyIds` in a Set, this is O(n).
    const accessible = (cid: string) =>
      companyIds === null || allowedCompanyIds?.has(cid) === true;

    const visiblePasswords = passwordRows.filter((r) => accessible(r.password.companyId));
    const visibleAssets = assetRows.filter((r) => accessible(r.asset.companyId));
    const visibleArticles = articleRows.filter((r) => accessible(r.article.companyId));

    // Single batch to resolve company names + archived state for all
    // the company IDs referenced by the nested entities.
    const referencedCompanyIds = new Set<string>();
    for (const r of visiblePasswords) referencedCompanyIds.add(r.password.companyId);
    for (const r of visibleAssets) referencedCompanyIds.add(r.asset.companyId);
    for (const r of visibleArticles) referencedCompanyIds.add(r.article.companyId);

    const companyLookupRows = referencedCompanyIds.size
      ? await this.prisma.company.findMany({
          where: { id: { in: [...referencedCompanyIds] } },
          select: { id: true, name: true, archivedAt: true },
        })
      : [];
    const companyLookup = new Map(
      companyLookupRows.map((c) => [c.id, c] as const),
    );

    const companyItems: StarredItem[] = await Promise.all(
      companyRows.map(async (r): Promise<StarredItem> => ({
        type: 'company',
        id: r.company.id,
        name: r.company.name,
        slug: r.company.slug,
        archivedAt: r.company.archivedAt?.toISOString() ?? null,
        starredAt: r.createdAt.toISOString(),
        companyId: r.company.id,
        companyName: r.company.name,
        memberCount: r.company._count.memberships,
        logo: await this.resolveLogo(r.company.logoUpload),
      })),
    );

    const passwordItems: StarredItem[] = visiblePasswords.map((r) => {
      const co = companyLookup.get(r.password.companyId);
      return {
        type: 'password',
        id: r.password.id,
        name: r.password.name,
        archivedAt: r.password.archivedAt?.toISOString() ?? null,
        starredAt: r.createdAt.toISOString(),
        companyId: r.password.companyId,
        companyName: co?.name ?? '',
        companyArchivedAt: co?.archivedAt?.toISOString() ?? null,
      };
    });

    const assetItems: StarredItem[] = visibleAssets.map((r) => {
      const co = companyLookup.get(r.asset.companyId);
      return {
        type: 'asset',
        id: r.asset.id,
        name: r.asset.name,
        archivedAt: r.asset.archivedAt?.toISOString() ?? null,
        starredAt: r.createdAt.toISOString(),
        companyId: r.asset.companyId,
        companyName: co?.name ?? '',
        companyArchivedAt: co?.archivedAt?.toISOString() ?? null,
        layoutName: r.asset.assetLayout?.name ?? null,
        layoutIcon: r.asset.assetLayout?.icon ?? null,
      };
    });

    const articleItems: StarredItem[] = visibleArticles.map((r) => {
      const co = companyLookup.get(r.article.companyId);
      return {
        type: 'article',
        id: r.article.id,
        name: r.article.title,
        slug: r.article.slug,
        archivedAt: r.article.archivedAt?.toISOString() ?? null,
        starredAt: r.createdAt.toISOString(),
        companyId: r.article.companyId,
        companyName: co?.name ?? '',
        companyArchivedAt: co?.archivedAt?.toISOString() ?? null,
      };
    });

    const items = [
      ...companyItems,
      ...passwordItems,
      ...assetItems,
      ...articleItems,
    ].sort((a, b) => {
      const byName = a.name.localeCompare(b.name, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
      if (byName !== 0) return byName;
      const byType = a.type.localeCompare(b.type);
      if (byType !== 0) return byType;
      return a.id.localeCompare(b.id);
    });

    return { items };
  }

  /**
   * Returns the set of company IDs the actor may see starred items on,
   * or `null` for SUPER_ADMIN (meaning "no filter — see everything").
   * Keeping this distinction in a dedicated nullable lets us skip the
   * `{ in: [...] }` Prisma clause entirely for super-admins, which is
   * both faster and avoids the Postgres `IN ()` empty-list edge case.
   */
  private async getAllowedCompanyIds(actor: AuthedUser): Promise<Set<string> | null> {
    if (actor.role === 'SUPER_ADMIN') return null;
    // Operators with non-NONE globalAccess implicitly see every
    // company, matching the tenant-scope guard in `prisma.service.ts`.
    if (
      actor.role === 'OPERATOR' &&
      (actor.globalAccess === 'FULL' || actor.globalAccess === 'READONLY')
    ) {
      return null;
    }
    const memberships = await this.prisma.membership.findMany({
      where: { userId: actor.id, revokedAt: null },
      select: { companyId: true },
    });
    return new Set(memberships.map((m) => m.companyId));
  }

  // ------------------------------------------------------------------
  // Batch helpers for list endpoints (populating isStarred on lists)
  // ------------------------------------------------------------------

  async listStarredCompanyIds(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.starredCompany.findMany({
      where: { userId },
      select: { companyId: true },
    });
    return new Set(rows.map((r) => r.companyId));
  }

  async listStarredPasswordIds(userId: string, passwordIds: string[]): Promise<Set<string>> {
    if (passwordIds.length === 0) return new Set();
    const rows = await this.prisma.starredPassword.findMany({
      where: { userId, passwordId: { in: passwordIds } },
      select: { passwordId: true },
    });
    return new Set(rows.map((r) => r.passwordId));
  }

  async listStarredAssetIds(userId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) return new Set();
    const rows = await this.prisma.starredAsset.findMany({
      where: { userId, assetId: { in: assetIds } },
      select: { assetId: true },
    });
    return new Set(rows.map((r) => r.assetId));
  }

  async listStarredArticleIds(userId: string, articleIds: string[]): Promise<Set<string>> {
    if (articleIds.length === 0) return new Set();
    const rows = await this.prisma.starredArticle.findMany({
      where: { userId, articleId: { in: articleIds } },
      select: { articleId: true },
    });
    return new Set(rows.map((r) => r.articleId));
  }

  // ------------------------------------------------------------------
  // Star / unstar by entity type
  // ------------------------------------------------------------------

  async star(
    actor: AuthedUser,
    entityType: EntityType,
    entityId: string,
    meta: { ip: string; userAgent: string },
  ) {
    const access = await this.assertCanAccess(actor, entityType, entityId);

    // Upsert so the endpoint stays idempotent — double-clicking the
    // star from two tabs shouldn't 409.
    const existing = await this.findStarred(actor.id, entityType, entityId);
    if (existing) {
      return { starred: true, starredAt: existing.createdAt.toISOString() };
    }

    const row = await this.createStarred(actor.id, entityType, entityId);

    await this.audit.log({
      actorId: actor.id,
      action: `${ENTITY_TYPE_TO_API_NAME[entityType]}.star`,
      entityType: this.entityTypeToAuditEntityType(entityType),
      entityId,
      companyId: access.companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { starredAt: row.createdAt.toISOString() },
    });

    return { starred: true, starredAt: row.createdAt.toISOString() };
  }

  async unstar(
    actor: AuthedUser,
    entityType: EntityType,
    entityId: string,
    meta: { ip: string; userAgent: string },
  ) {
    // We don't call assertCanAccess on unstar so a user who lost
    // membership can still remove the dangling star without a 403.
    const existing = await this.findStarred(actor.id, entityType, entityId);
    if (!existing) return { starred: false };

    // Retrieve companyId for audit before deleting
    const companyId = await this.getCompanyIdForEntity(entityType, entityId);

    await this.deleteStarred(actor.id, entityType, entityId);

    await this.audit.log({
      actorId: actor.id,
      action: `${ENTITY_TYPE_TO_API_NAME[entityType]}.unstar`,
      entityType: this.entityTypeToAuditEntityType(entityType),
      entityId,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { starredAt: existing.createdAt.toISOString() },
      after: null,
    });

    return { starred: false };
  }

  // ------------------------------------------------------------------
  // Check if entity is starred (for detail endpoints)
  // ------------------------------------------------------------------

  async isStarred(userId: string, entityType: EntityType, entityId: string): Promise<boolean> {
    const row = await this.findStarred(userId, entityType, entityId);
    return !!row;
  }

  // ------------------------------------------------------------------
  // Access control
  // ------------------------------------------------------------------

  private async assertCanAccess(
    actor: AuthedUser,
    entityType: EntityType,
    entityId: string,
  ): Promise<{ companyId: string }> {
    // CLIENT_USER cannot star anything (operator UX feature)
    if (actor.role === 'CLIENT_USER') {
      throw new ForbiddenException('Client users cannot star entities');
    }

    // SUPER_ADMIN can star any entity
    if (actor.role === 'SUPER_ADMIN') {
      const companyId = await this.getCompanyIdForEntity(entityType, entityId);
      return { companyId };
    }

    // For other roles, verify entity exists and actor has membership on its company
    const companyId = await this.getCompanyIdForEntity(entityType, entityId);

    const membership = await this.prisma.membership.findFirst({
      where: { userId: actor.id, companyId, revokedAt: null },
      select: { id: true },
    });

    if (!membership) {
      // 404 rather than 403 mirrors the existing tenant-scoped patterns
      // elsewhere — don't leak existence of entities the caller can't access.
      throw new NotFoundException();
    }

    return { companyId };
  }

  // ------------------------------------------------------------------
  // Entity helpers
  // ------------------------------------------------------------------

  private async getCompanyIdForEntity(entityType: EntityType, entityId: string): Promise<string> {
    switch (entityType) {
      case 'company': {
        const company = await this.prisma.company.findUnique({
          where: { id: entityId },
          select: { id: true },
        });
        if (!company) throw new NotFoundException();
        return company.id;
      }
      case 'password': {
        const password = await this.prisma.password.findUnique({
          where: { id: entityId },
          select: { companyId: true },
        });
        if (!password) throw new NotFoundException();
        return password.companyId;
      }
      case 'asset': {
        const asset = await this.prisma.asset.findUnique({
          where: { id: entityId },
          select: { companyId: true },
        });
        if (!asset) throw new NotFoundException();
        return asset.companyId;
      }
      case 'article': {
        const article = await this.prisma.article.findUnique({
          where: { id: entityId },
          select: { companyId: true },
        });
        if (!article) throw new NotFoundException();
        return article.companyId;
      }
    }
  }

  private entityTypeToAuditEntityType(entityType: EntityType): string {
    switch (entityType) {
      case 'company':
        return 'Company';
      case 'password':
        return 'Password';
      case 'asset':
        return 'Asset';
      case 'article':
        return 'Article';
    }
  }

  // ------------------------------------------------------------------
  // Database helpers for starred records
  // ------------------------------------------------------------------

  private async findStarred(userId: string, entityType: EntityType, entityId: string) {
    switch (entityType) {
      case 'company':
        return this.prisma.starredCompany.findUnique({
          where: { userId_companyId: { userId, companyId: entityId } },
        });
      case 'password':
        return this.prisma.starredPassword.findUnique({
          where: { userId_passwordId: { userId, passwordId: entityId } },
        });
      case 'asset':
        return this.prisma.starredAsset.findUnique({
          where: { userId_assetId: { userId, assetId: entityId } },
        });
      case 'article':
        return this.prisma.starredArticle.findUnique({
          where: { userId_articleId: { userId, articleId: entityId } },
        });
    }
  }

  private async createStarred(userId: string, entityType: EntityType, entityId: string) {
    switch (entityType) {
      case 'company':
        return this.prisma.starredCompany.create({
          data: { userId, companyId: entityId },
        });
      case 'password':
        return this.prisma.starredPassword.create({
          data: { userId, passwordId: entityId },
        });
      case 'asset':
        return this.prisma.starredAsset.create({
          data: { userId, assetId: entityId },
        });
      case 'article':
        return this.prisma.starredArticle.create({
          data: { userId, articleId: entityId },
        });
    }
  }

  private async deleteStarred(userId: string, entityType: EntityType, entityId: string) {
    switch (entityType) {
      case 'company':
        await this.prisma.starredCompany.delete({
          where: { userId_companyId: { userId, companyId: entityId } },
        });
        break;
      case 'password':
        await this.prisma.starredPassword.delete({
          where: { userId_passwordId: { userId, passwordId: entityId } },
        });
        break;
      case 'asset':
        await this.prisma.starredAsset.delete({
          where: { userId_assetId: { userId, assetId: entityId } },
        });
        break;
      case 'article':
        await this.prisma.starredArticle.delete({
          where: { userId_articleId: { userId, articleId: entityId } },
        });
        break;
    }
  }

  // ------------------------------------------------------------------
  // Logo resolution (kept for backward compat with list)
  // ------------------------------------------------------------------

  private async resolveLogo(
    upload:
      | {
          id: string;
          storageKey: string;
          thumbnailKey: string | null;
          mimeType: string;
          sizeBytes: number;
          companyId: string;
          createdAt: Date;
        }
      | null,
  ) {
    if (!upload) return null;
    try {
      const [full, thumb] = await Promise.all([
        this.minio.presignGet(upload.companyId, upload.storageKey, {
          ttlSeconds: 300,
        }),
        upload.thumbnailKey
          ? this.minio.presignGet(upload.companyId, upload.thumbnailKey, {
              ttlSeconds: 300,
            })
          : Promise.resolve(null),
      ]);
      return {
        uploadId: upload.id,
        url: full.url,
        thumbnailUrl: thumb?.url ?? null,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        uploadedAt: upload.createdAt.toISOString(),
      };
    } catch {
      return {
        uploadId: upload.id,
        url: null,
        thumbnailUrl: null,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        uploadedAt: upload.createdAt.toISOString(),
      };
    }
  }
}
