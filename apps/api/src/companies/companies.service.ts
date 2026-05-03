import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateCompanyInput,
  UpdateCompanyInput,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { MembershipCacheService } from '../cache/membership-cache.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export interface CompanyListOptions {
  includeArchived?: boolean;
  q?: string;
  limit?: number;
  cursor?: string;
  /**
   * Phase 9a: used by the parent-company picker to exclude the current
   * company from its own typeahead results. Cycle prevention still runs
   * server-side on update; this is purely a UX hint.
   */
  excludeIds?: string[];
  /**
   * Phase 9b.3: ordering hint. Accepts `'updatedAt'` for the operator
   * home "Recent companies" row; omitted / anything else falls back to
   * alphabetical name ASC.
   */
  sort?: 'updatedAt';
  order?: 'asc' | 'desc';
}

/**
 * Fields we track for diff-based audit. Keeping the list explicit (as
 * opposed to "everything on the row") prevents `updatedAt`, internal
 * timestamps, or future columns from polluting the audit output.
 */
const AUDITABLE_COMPANY_FIELDS = [
  'name',
  'slug',
  'notes',
  'quickNotes',
  'type',
  'parentCompanyId',
  'logoUploadId',
  'contactName',
  'contactTitle',
  'contactEmail',
  'contactPhone',
  'generalEmail',
  'phone',
  'fax',
  'website',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
  'country',
  'stickyNoteText',
  'stickyNoteSeverity',
] as const;

const COMPANY_LIST_SELECT = {
  id: true,
  name: true,
  slug: true,
  notes: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  type: true,
  city: true,
  region: true,
  country: true,
  website: true,
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

const COMPANY_DETAIL_SELECT = {
  ...COMPANY_LIST_SELECT,
  createdBy: true,
  quickNotes: true,
  parentCompanyId: true,
  parent: {
    select: {
      id: true,
      name: true,
      slug: true,
      archivedAt: true,
    },
  },
  contactName: true,
  contactTitle: true,
  contactEmail: true,
  contactPhone: true,
  generalEmail: true,
  phone: true,
  fax: true,
  addressLine1: true,
  addressLine2: true,
  postalCode: true,
  stickyNoteText: true,
  stickyNoteSeverity: true,
} as const;

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly cache: MembershipCacheService,
  ) {}

  async list(actor: AuthedUser, options: CompanyListOptions = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const where: Record<string, unknown> = {};
    if (!options.includeArchived) {
      where.archivedAt = null;
    }
    if (options.q) {
      where.OR = [
        { name: { contains: options.q, mode: 'insensitive' } },
        { slug: { contains: options.q.toLowerCase() } },
      ];
    }
    if (options.excludeIds && options.excludeIds.length > 0) {
      where.id = { notIn: options.excludeIds };
    }
    // RBAC v2 — visibility for the company list:
    //   - SUPER_ADMIN              → every row
    //   - OPERATOR with FULL/READONLY globalAccess
    //                              → every row (per-company membership
    //                                only ever *upgrades* access; the
    //                                fallback already grants READ)
    //   - OPERATOR with NONE       → only companies they're a member of
    //   - CONTRACTOR / CLIENT_USER → only companies they're a member of
    if (actor.role !== 'SUPER_ADMIN') {
      const seesEverything =
        actor.role === 'OPERATOR' &&
        actor.globalAccess !== null &&
        actor.globalAccess !== 'NONE';
      if (!seesEverything) {
        const memberships = await this.prisma.membership.findMany({
          where: { userId: actor.id, revokedAt: null },
          select: { companyId: true },
        });
        const ids = memberships.map((m) => m.companyId);
        if (ids.length === 0) return { items: [], nextCursor: null };
        const allowed = options.excludeIds
          ? ids.filter((id) => !options.excludeIds!.includes(id))
          : ids;
        if (allowed.length === 0) return { items: [], nextCursor: null };
        where.id = { in: allowed };
      }
    }

    // Phase 9b.3: sort by `updatedAt desc` when the caller asks — used
    // by the operator home "Recent companies" widget. Default ordering
    // remains alphabetical so the main companies list stays scannable.
    const orderBy =
      options.sort === 'updatedAt'
        ? ({ updatedAt: options.order === 'asc' ? 'asc' : 'desc' } as const)
        : ({ name: 'asc' } as const);

    const items = await this.prisma.company.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      select: COMPANY_LIST_SELECT,
    });
    const hasMore = items.length > limit;
    const slice = hasMore ? items.slice(0, limit) : items;

    // Single query for star state, joined in memory. Avoids an N+1
    // and returns an empty set when the caller has starred nothing.
    const starredIds = await this.loadStarredCompanyIds(
      actor.id,
      slice.map((c) => c.id),
    );

    const resolved = await Promise.all(
      slice.map(async (c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        notes: c.notes,
        archivedAt: c.archivedAt,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        memberCount: c._count.memberships,
        type: c.type,
        city: c.city,
        region: c.region,
        country: c.country,
        website: c.website,
        logoUploadId: c.logoUploadId,
        logo: await this.resolveLogo(c.logoUpload),
        isStarred: starredIds.has(c.id),
      })),
    );

    return {
      items: resolved,
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  private async loadStarredCompanyIds(
    userId: string,
    companyIds: string[],
  ): Promise<Set<string>> {
    if (companyIds.length === 0) return new Set();
    const rows = await this.prisma.starredCompany.findMany({
      where: { userId, companyId: { in: companyIds } },
      select: { companyId: true },
    });
    return new Set(rows.map((r) => r.companyId));
  }

  async get(actor: AuthedUser, id: string) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      select: COMPANY_DETAIL_SELECT,
    });
    if (!company) throw new NotFoundException();
    // The PermissionGuard on `company.read` already verified the
    // caller has FULL or READONLY effective access via membership or
    // operator globalAccess, so we don't repeat that check here.

    const [logo, childrenCount, star] = await Promise.all([
      this.resolveLogo(company.logoUpload),
      this.prisma.company.count({ where: { parentCompanyId: id } }),
      this.prisma.starredCompany.findUnique({
        where: { userId_companyId: { userId: actor.id, companyId: id } },
        select: { createdAt: true },
      }),
    ]);

    return {
      id: company.id,
      name: company.name,
      slug: company.slug,
      notes: company.notes,
      archivedAt: company.archivedAt,
      createdAt: company.createdAt,
      updatedAt: company.updatedAt,
      createdBy: company.createdBy,
      memberCount: company._count.memberships,
      isStarred: !!star,

      type: company.type,
      quickNotes: company.quickNotes,
      parentCompanyId: company.parentCompanyId,
      parent: company.parent,
      childrenCount,

      contactName: company.contactName,
      contactTitle: company.contactTitle,
      contactEmail: company.contactEmail,
      contactPhone: company.contactPhone,

      generalEmail: company.generalEmail,
      phone: company.phone,
      fax: company.fax,
      website: company.website,

      addressLine1: company.addressLine1,
      addressLine2: company.addressLine2,
      city: company.city,
      region: company.region,
      postalCode: company.postalCode,
      country: company.country,

      stickyNoteText: company.stickyNoteText,
      stickyNoteSeverity: company.stickyNoteSeverity,

      logoUploadId: company.logoUploadId,
      logo,
    };
  }

  async create(
    actor: AuthedUser,
    input: CreateCompanyInput,
    meta: { ip: string; userAgent: string },
  ) {
    const dupe = await this.prisma.company.findUnique({ where: { slug: input.slug } });
    if (dupe) throw new ConflictException(`Slug "${input.slug}" is taken`);

    const company = await this.prisma.company.create({
      data: {
        name: input.name,
        slug: input.slug,
        type: input.type ?? 'CLIENT',
        notes: input.notes ?? null,
        createdBy: actor.id,
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'company.create',
      entityType: 'Company',
      entityId: company.id,
      companyId: company.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        name: company.name,
        slug: company.slug,
        type: company.type,
        notes: company.notes,
      },
    });
    return company;
  }

  async update(
    actor: AuthedUser,
    id: string,
    input: UpdateCompanyInput,
    meta: { ip: string; userAgent: string },
  ) {
    const before = await this.prisma.company.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    if (input.slug && input.slug !== before.slug) {
      const dupe = await this.prisma.company.findUnique({ where: { slug: input.slug } });
      if (dupe) throw new ConflictException(`Slug "${input.slug}" is taken`);
    }

    if (input.parentCompanyId !== undefined && input.parentCompanyId !== null) {
      if (input.parentCompanyId === id) {
        throw new BadRequestException('A company cannot be its own parent');
      }
      const parent = await this.prisma.company.findUnique({
        where: { id: input.parentCompanyId },
        select: { id: true },
      });
      if (!parent) {
        throw new BadRequestException('Parent company not found');
      }
      await this.ensureNoParentCycle(id, input.parentCompanyId);
    }

    if (input.logoUploadId !== undefined && input.logoUploadId !== null) {
      const upload = await this.prisma.upload.findUnique({
        where: { id: input.logoUploadId },
        select: { id: true, companyId: true, isImage: true, deletedAt: true },
      });
      if (!upload || upload.deletedAt) {
        throw new BadRequestException('Logo upload not found');
      }
      if (upload.companyId !== id) {
        // Cross-tenant guard: an operator with access to two tenants
        // could otherwise point company A at company B's upload.
        throw new BadRequestException('Logo upload belongs to a different company');
      }
      if (!upload.isImage) {
        throw new BadRequestException('Logo upload must be an image');
      }
    }

    // Normalise website: allow bare hostnames and prepend https://.
    const website =
      input.website === undefined
        ? undefined
        : normalizeWebsite(input.website);

    // Sticky note pair reconciliation. The two columns are coupled:
    //   - Clearing the text (null) also clears the severity, otherwise
    //     a stale severity would linger on a hidden banner.
    //   - Setting text without specifying severity defaults to INFO so
    //     forms that only edit one half don't have to remember to send
    //     the other. An explicit severity in `input` always wins.
    const stickyNoteText = input.stickyNoteText;
    let stickyNoteSeverity: 'INFO' | 'WARN' | 'CRITICAL' | null | undefined =
      input.stickyNoteSeverity;
    if (stickyNoteText === null) {
      stickyNoteSeverity = null;
    } else if (
      stickyNoteText !== undefined &&
      stickyNoteSeverity === undefined &&
      before.stickyNoteSeverity === null
    ) {
      stickyNoteSeverity = 'INFO';
    }

    const company = await this.prisma.company.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.quickNotes !== undefined ? { quickNotes: input.quickNotes } : {}),
        ...(input.parentCompanyId !== undefined
          ? { parentCompanyId: input.parentCompanyId }
          : {}),
        ...(input.logoUploadId !== undefined
          ? { logoUploadId: input.logoUploadId }
          : {}),
        ...(input.contactName !== undefined ? { contactName: input.contactName } : {}),
        ...(input.contactTitle !== undefined ? { contactTitle: input.contactTitle } : {}),
        ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
        ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
        ...(input.generalEmail !== undefined ? { generalEmail: input.generalEmail } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.fax !== undefined ? { fax: input.fax } : {}),
        ...(website !== undefined ? { website } : {}),
        ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
        ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
        ...(input.country !== undefined ? { country: input.country } : {}),
        ...(stickyNoteText !== undefined ? { stickyNoteText } : {}),
        ...(stickyNoteSeverity !== undefined ? { stickyNoteSeverity } : {}),
      },
    });

    await this.audit.logChange({
      actorId: actor.id,
      action: 'company.update',
      entityType: 'Company',
      entityId: company.id,
      companyId: company.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: pickAuditable(before),
      after: pickAuditable(company),
      fields: AUDITABLE_COMPANY_FIELDS,
    });
    return company;
  }

  async archive(
    actor: AuthedUser,
    id: string,
    meta: { ip: string; userAgent: string },
  ) {
    const before = await this.prisma.company.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    if (before.archivedAt) throw new BadRequestException('Already archived');

    const company = await this.prisma.company.update({
      where: { id },
      data: { archivedAt: new Date() },
    });

    const members = await this.prisma.membership.findMany({
      where: { companyId: id, revokedAt: null },
      select: { userId: true },
    });
    await this.cache.invalidateMany(members.map((m) => m.userId));

    await this.audit.log({
      actorId: actor.id,
      action: 'company.archive',
      entityType: 'Company',
      entityId: company.id,
      companyId: company.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: before.archivedAt },
      after: { archivedAt: company.archivedAt },
    });
    return company;
  }

  async restore(
    actor: AuthedUser,
    id: string,
    meta: { ip: string; userAgent: string },
  ) {
    const before = await this.prisma.company.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    if (!before.archivedAt) throw new BadRequestException('Not archived');

    const company = await this.prisma.company.update({
      where: { id },
      data: { archivedAt: null },
    });

    const members = await this.prisma.membership.findMany({
      where: { companyId: id, revokedAt: null },
      select: { userId: true },
    });
    await this.cache.invalidateMany(members.map((m) => m.userId));

    await this.audit.log({
      actorId: actor.id,
      action: 'company.restore',
      entityType: 'Company',
      entityId: company.id,
      companyId: company.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: before.archivedAt },
      after: { archivedAt: null },
    });
    return company;
  }

  /**
   * Walk up the parent chain starting from `proposedParentId`. If we
   * encounter `selfId` anywhere along the way, the new edge would
   * introduce a cycle.
   */
  private async ensureNoParentCycle(
    selfId: string,
    proposedParentId: string,
  ): Promise<void> {
    let cursor: string | null = proposedParentId;
    const seen = new Set<string>();
    // Hard cap to avoid pathological infinite loops if the DB somehow
    // has orphaned cycles today.
    for (let i = 0; i < 50 && cursor; i++) {
      if (cursor === selfId) {
        throw new BadRequestException(
          'Parent company would create a circular hierarchy',
        );
      }
      if (seen.has(cursor)) {
        throw new BadRequestException(
          'Parent chain already contains a cycle — contact an admin',
        );
      }
      seen.add(cursor);
      const row: { parentCompanyId: string | null } | null =
        await this.prisma.company.findUnique({
          where: { id: cursor },
          select: { parentCompanyId: true },
        });
      cursor = row?.parentCompanyId ?? null;
    }
  }

  /**
   * Turn a stored `Upload` row into the UI-shaped logo descriptor.
   * URLs point at the same-origin API streaming endpoint
   * (`/uploads/:id/image`) so the browser never reaches the storage
   * layer directly — one reverse-proxy entry covers everything.
   * Returns `null` when there's no logo — all callers branch on that.
   */
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
    const base = `/api/v1/companies/${upload.companyId}/uploads/${upload.id}/image`;
    return {
      uploadId: upload.id,
      url: base,
      thumbnailUrl: upload.thumbnailKey ? `${base}?v=thumb` : null,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      uploadedAt: upload.createdAt.toISOString(),
    };
  }
}

function pickAuditable(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of AUDITABLE_COMPANY_FIELDS) {
    out[k] = row[k] ?? null;
  }
  return out;
}

function normalizeWebsite(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
