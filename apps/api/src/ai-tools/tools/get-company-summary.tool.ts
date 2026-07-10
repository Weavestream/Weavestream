import { Injectable, NotFoundException } from '@nestjs/common';
import type { GetCompanySummaryToolOutput } from '@weavestream/shared';
import { PermissionService } from '../../rbac/permission.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { passwordReadWhereFor } from '../../passwords/password-access-policy.js';
import { companyHrefFor } from '../../search/entity-href.js';
import { AI_TOOL_SPECS } from '../tool-specs.js';
import type { AiReadTool, AiToolExecutionContext } from '../tool-registry.js';
import type { Action } from '../../rbac/permissions.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `get_company_summary` — the company comes EXCLUSIVELY from the
 * trusted turn context (the page the chat was opened on); the tool
 * takes no arguments so the model can never pick a company.
 *
 * Beyond the executor's `company.read` entry gate, every count section
 * is gated by its own read permission and OMITTED — never zeroed —
 * when unauthorized: a zero would be a presence side channel. Count
 * WHEREs carry the same visibility predicates as the list surfaces,
 * split per model (uploads use `deletedAt`, not `archivedAt`).
 */
@Injectable()
export class GetCompanySummaryAiTool implements AiReadTool {
  readonly spec = AI_TOOL_SPECS.get_company_summary;

  constructor(
    private readonly permissions: PermissionService,
    private readonly prisma: PrismaService,
  ) {}

  async resolveCompanyId(ctx: AiToolExecutionContext): Promise<string | null> {
    return ctx.turnContext?.companyId ?? null;
  }

  async execute(
    ctx: AiToolExecutionContext,
    _args: Record<string, unknown>,
    companyId: string | null,
  ): Promise<GetCompanySummaryToolOutput> {
    if (companyId === null) throw new NotFoundException();
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, archivedAt: null },
      select: { id: true, name: true, slug: true },
    });
    if (!company) throw new NotFoundException();

    const isClient = ctx.actor.role === 'CLIENT_USER';
    const clientVisible = isClient ? { visibleToClients: true } : {};

    const allowed = async (action: Action): Promise<boolean> =>
      (await this.permissions.can(ctx.actor, action, { companyId })).allowed;

    const [assets, articles, domains, passwords, uploads, audit] = await Promise.all([
      (await allowed('asset.read'))
        ? this.prisma.asset.count({ where: { companyId, archivedAt: null } })
        : null,
      (await allowed('article.read'))
        ? this.prisma.article.count({
            where: { companyId, archivedAt: null, ...clientVisible },
          })
        : null,
      (await allowed('domain.read'))
        ? this.prisma.monitoredDomain.count({
            where: { companyId, archivedAt: null, ...clientVisible },
          })
        : null,
      (await allowed('password.read'))
        ? this.prisma.password.count({
            where: {
              companyId,
              archivedAt: null,
              ...passwordReadWhereFor(ctx.actor),
            },
          })
        : null,
      (await allowed('upload.read'))
        ? this.prisma.upload.count({ where: { companyId, deletedAt: null } })
        : null,
      (await allowed('audit.read'))
        ? this.prisma.auditLog.count({
            where: {
              companyId,
              createdAt: { gte: new Date(Date.now() - THIRTY_DAYS_MS) },
            },
          })
        : null,
    ]);

    return {
      companyId: company.id,
      companyName: company.name,
      href: companyHrefFor({
        companyId: company.id,
        companySlug: company.slug,
        isClient,
      }),
      // Omitted (not zeroed) when the section's permission is missing.
      ...(assets !== null ? { assets } : {}),
      ...(articles !== null ? { articles } : {}),
      ...(domains !== null ? { domains } : {}),
      ...(passwords !== null ? { passwords } : {}),
      ...(uploads !== null ? { uploads } : {}),
      ...(audit !== null ? { auditEventsLast30d: audit } : {}),
    };
  }
}
