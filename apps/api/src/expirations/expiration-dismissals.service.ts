import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ExpirationDismissal } from '@prisma/client';
import { expirationDismissalKey, type DismissExpirationInput } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { PermissionService } from '../rbac/permission.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { canReadPassword } from '../passwords/password-access-policy.js';

/** The permission that lets an actor act on each kind of expiring item. */
const MANAGE_ACTION = {
  'asset-field': 'asset.write',
  domain: 'domain.manage',
  password: 'password.write',
} as const;

const DOMAIN_SOURCES = new Set(['registrar', 'tls']);
const PASSWORD_SOURCES = new Set(['expiry', 'rotation']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dismissals for the Expiring-soon feed. A dismissal hides one item for one
 * due date; a different date (renewed, then lapsing again) is a new item.
 * Nothing about the underlying asset, domain or password is changed.
 */
@Injectable()
export class ExpirationDismissalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly permissions: PermissionService,
  ) {}

  /** Dismissals keyed by `expirationDismissalKey`, optionally for one company. */
  loadMap(companyId?: string): Promise<Map<string, ExpirationDismissal>> {
    return loadDismissalMap(this.prisma, companyId);
  }

  async dismiss(
    actor: AuthedUser,
    companyId: string,
    input: DismissExpirationInput,
    meta: { ip: string; userAgent: string },
  ): Promise<ExpirationDismissal> {
    const dueAt = new Date(input.dueAt);
    if (Number.isNaN(dueAt.getTime())) throw new BadRequestException('dueAt is not a valid date.');

    await this.assertCanManage(actor, companyId, input.kind);
    const current = await this.currentDueDate(actor, companyId, input);
    // Only the date the item is due on now: a future date dismissed ahead of
    // time would silently suppress the item once it moved to that date.
    if (!current || current.getTime() !== dueAt.getTime()) {
      throw new BadRequestException('That is not the current due date for this item.');
    }

    const note = input.note?.length ? input.note : null;
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.expirationDismissal.upsert({
        where: {
          kind_entityId_source_dueAt: {
            kind: input.kind,
            entityId: input.entityId,
            source: input.source,
            dueAt,
          },
        },
        create: {
          companyId,
          kind: input.kind,
          entityId: input.entityId,
          source: input.source,
          dueAt,
          note,
          dismissedBy: actor.id,
        },
        update: { note, dismissedBy: actor.id },
      });
      await this.audit.logWithClient(tx, {
        actorId: actor.id,
        action: AUDIT_ACTIONS.expiration.dismiss,
        entityType: 'ExpirationDismissal',
        entityId: row.id,
        companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          kind: row.kind,
          entityId: row.entityId,
          source: row.source,
          dueAt: row.dueAt,
          note: row.note,
        },
      });
      return row;
    });
  }

  async restore(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: { ip: string; userAgent: string },
  ): Promise<void> {
    // Scoped by company: a dismissal id from another tenant is not found.
    const row = await this.prisma.expirationDismissal.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException();
    const kind = row.kind as DismissExpirationInput['kind'];
    await this.assertCanManage(actor, companyId, kind);
    // Same item access as dismissing (e.g. a password restricted since).
    await this.currentDueDate(actor, companyId, {
      kind,
      entityId: row.entityId,
      source: row.source,
      dueAt: row.dueAt.toISOString(),
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.expirationDismissal.deleteMany({ where: { id, companyId } });
      await this.audit.logWithClient(tx, {
        actorId: actor.id,
        action: AUDIT_ACTIONS.expiration.restore,
        entityType: 'ExpirationDismissal',
        entityId: row.id,
        companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: {
          kind: row.kind,
          entityId: row.entityId,
          source: row.source,
          dueAt: row.dueAt,
          note: row.note,
        },
        after: null,
      });
    });
  }

  private async assertCanManage(
    actor: AuthedUser,
    companyId: string,
    kind: DismissExpirationInput['kind'],
  ): Promise<void> {
    const decision = await this.permissions.can(actor, MANAGE_ACTION[kind], { companyId });
    if (!decision.allowed) {
      throw new ForbiddenException('You cannot manage these items in this company.');
    }
  }

  /**
   * The item's current due date for this source, computed the same way as the
   * Expiring-soon feed. Throws if the item is not in this company or not
   * visible to the actor (IDOR: knowing an id is not access), or if the source
   * is not one that kind has.
   */
  private async currentDueDate(
    actor: AuthedUser,
    companyId: string,
    input: DismissExpirationInput,
  ): Promise<Date | null> {
    if (input.kind === 'domain') {
      if (!DOMAIN_SOURCES.has(input.source))
        throw new BadRequestException('Unknown domain source.');
      const d = await this.prisma.monitoredDomain.findFirst({
        where: {
          id: input.entityId,
          companyId,
          ...(actor.role === 'CLIENT_USER' ? { visibleToClients: true } : {}),
        },
        select: { whoisExpiresAt: true, tlsExpiresAt: true },
      });
      if (!d) throw new NotFoundException();
      return input.source === 'tls' ? d.tlsExpiresAt : d.whoisExpiresAt;
    }
    if (input.kind === 'password') {
      if (!PASSWORD_SOURCES.has(input.source))
        throw new BadRequestException('Unknown password source.');
      const p = await this.prisma.password.findFirst({
        where: { id: input.entityId, companyId },
        select: {
          visibleToClients: true,
          restrictedToUserIds: true,
          expiresAt: true,
          lastRotatedAt: true,
          rotationReminderDays: true,
        },
      });
      if (!p || !canReadPassword(actor, p)) throw new NotFoundException();
      if (input.source === 'expiry') return p.expiresAt;
      if (p.rotationReminderDays == null || !p.lastRotatedAt) return null;
      return new Date(p.lastRotatedAt.getTime() + p.rotationReminderDays * 86_400_000);
    }
    // asset-field: the asset is in the company and the field belongs to its layout.
    if (!UUID_RE.test(input.source)) throw new NotFoundException();
    const a = await this.prisma.asset.findFirst({
      where: { id: input.entityId, companyId },
      select: { id: true, assetLayoutId: true },
    });
    if (!a) throw new NotFoundException();
    const field = await this.prisma.assetField.findFirst({
      where: {
        id: input.source,
        assetLayoutId: a.assetLayoutId,
        // Same rule as asset writes: clients never touch MSP-internal fields.
        ...(actor.role === 'CLIENT_USER' ? { visibleToClients: true } : {}),
      },
      select: { id: true },
    });
    if (!field) throw new NotFoundException();
    const v = await this.prisma.assetFieldValue.findFirst({
      where: { assetId: a.id, assetFieldId: field.id, companyId },
      select: { value: true },
    });
    // DATE is stored as "YYYY-MM-DD", DATETIME as an ISO timestamp.
    if (typeof v?.value !== 'string' || v.value.length === 0) return null;
    const at = new Date(v.value);
    return Number.isNaN(at.getTime()) ? null : at;
  }
}

/**
 * Dismissals keyed by `expirationDismissalKey`. A plain function (not a
 * service method) so the worker-side alerts runner and the domains alerts
 * query can use it without new DI wiring.
 */
export async function loadDismissalMap(
  prisma: Pick<PrismaService, 'expirationDismissal'>,
  companyId?: string,
  kind?: DismissExpirationInput['kind'],
): Promise<Map<string, ExpirationDismissal>> {
  const rows = await prisma.expirationDismissal.findMany({
    where: { ...(companyId ? { companyId } : {}), ...(kind ? { kind } : {}) },
  });
  return new Map(
    rows.map((r) => [expirationDismissalKey(r.kind, r.entityId, r.source, r.dueAt), r] as const),
  );
}
