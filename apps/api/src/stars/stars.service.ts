import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { MinioService } from '../storage/minio.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Phase 9b.3 — per-user "Starred companies".
 *
 * Stars are independent of Membership: a SUPER_ADMIN may star any
 * company, while everyone else may only star a company they already
 * hold a non-revoked membership on. That keeps the client-portal
 * tenant isolation story unchanged — a CLIENT_VIEWER cannot surface
 * companies they otherwise can't see just by starring one.
 */

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

@Injectable()
export class StarsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly minio: MinioService,
  ) {}

  async list(actor: AuthedUser) {
    const rows = await this.prisma.starredCompany.findMany({
      where: { userId: actor.id },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        company: { select: STAR_COMPANY_SELECT },
      },
    });
    const items = await Promise.all(
      rows.map(async (r) => ({
        id: r.company.id,
        name: r.company.name,
        slug: r.company.slug,
        archivedAt: r.company.archivedAt,
        updatedAt: r.company.updatedAt,
        type: r.company.type,
        city: r.company.city,
        region: r.company.region,
        country: r.company.country,
        website: r.company.website,
        memberCount: r.company._count.memberships,
        starredAt: r.createdAt,
        logo: await this.resolveLogo(r.company.logoUpload),
      })),
    );
    return { items };
  }

  async listStarredCompanyIds(userId: string): Promise<Set<string>> {
    const rows = await this.prisma.starredCompany.findMany({
      where: { userId },
      select: { companyId: true },
    });
    return new Set(rows.map((r) => r.companyId));
  }

  async star(
    actor: AuthedUser,
    companyId: string,
    meta: { ip: string; userAgent: string },
  ) {
    await this.assertCanAccess(actor, companyId);

    // Upsert so the endpoint stays idempotent — double-clicking the
    // star from two tabs shouldn't 409.
    const existing = await this.prisma.starredCompany.findUnique({
      where: { userId_companyId: { userId: actor.id, companyId } },
    });
    if (existing) {
      return { starred: true, starredAt: existing.createdAt.toISOString() };
    }
    const row = await this.prisma.starredCompany.create({
      data: { userId: actor.id, companyId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'company.star',
      entityType: 'Company',
      entityId: companyId,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { starredAt: row.createdAt.toISOString() },
    });
    return { starred: true, starredAt: row.createdAt.toISOString() };
  }

  async unstar(
    actor: AuthedUser,
    companyId: string,
    meta: { ip: string; userAgent: string },
  ) {
    // We don't call assertCanAccess on unstar so a user who lost
    // membership can still remove the dangling star without a 403.
    const existing = await this.prisma.starredCompany.findUnique({
      where: { userId_companyId: { userId: actor.id, companyId } },
    });
    if (!existing) return { starred: false };
    await this.prisma.starredCompany.delete({
      where: { userId_companyId: { userId: actor.id, companyId } },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'company.unstar',
      entityType: 'Company',
      entityId: companyId,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { starredAt: existing.createdAt.toISOString() },
      after: null,
    });
    return { starred: false };
  }

  private async assertCanAccess(
    actor: AuthedUser,
    companyId: string,
  ): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });
    if (!company) throw new NotFoundException();
    if (actor.role === 'SUPER_ADMIN') return;
    const membership = await this.prisma.membership.findFirst({
      where: { userId: actor.id, companyId, revokedAt: null },
      select: { id: true },
    });
    if (!membership) {
      // 404 rather than 403 mirrors the existing tenant-scoped patterns
      // elsewhere (see CompaniesService.get) — don't leak existence of
      // companies the caller can't access.
      throw new NotFoundException();
    }
    // Don't bother with expiry here: a contractor pinning a company
    // they once had access to is harmless — actual data access is
    // still gated by the existing permission guards.
    if (actor.role === 'CLIENT_USER') {
      // Intentional: CLIENT users are a portal concept, not an
      // operator-dashboard one. Guard against future code paths that
      // might expose /me/stars in the client portal.
      throw new ForbiddenException('Client users cannot star companies');
    }
  }

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
