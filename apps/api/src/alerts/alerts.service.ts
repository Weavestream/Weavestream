import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AlertConfig as AlertConfigRow } from '@prisma/client';
import {
  type AlertConfig,
  type AlertConfigCompanyRef,
  type AlertConfigInput,
  type AlertConfigPatch,
  type AlertExpirationKind,
  type AlertRecordAction,
  type AlertRecordEntityType,
  type AlertTestInput,
  type AlertType,
  alertConfigInputSchema,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { EmailService } from '../email/email.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';
import { AlertEmitterService } from './alert-emitter.service.js';

/**
 * CRUD service for `AlertConfig` rows.
 *
 * Two cross-cutting concerns this service owns:
 *   1. Always invalidate the `AlertEmitterService` cache on every
 *      successful write — without that, freshly created
 *      RECORD_EVENT / PASSWORD_EVENT configs would not fire until the
 *      emitter's 60s safety-net refresh.
 *   2. Audit emit (`alert.create` / `alert.update` / `alert.archive`
 *      / `alert.test`) so admins can trace who set up which alert.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly email: EmailService,
    private readonly emitter: AlertEmitterService,
  ) {}

  async list(): Promise<AlertConfig[]> {
    const rows = await this.prisma.alertConfig.findMany({
      where: { archivedAt: null },
      orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }],
    });
    const companies = await this.loadCompanyRefs(
      rows.map((r) => r.companyId),
    );
    return rows.map((r) => toDto(r, companies.get(r.companyId ?? '') ?? null));
  }

  async getById(id: string): Promise<AlertConfig> {
    const row = await this.prisma.alertConfig.findFirst({
      where: { id, archivedAt: null },
    });
    if (!row) throw new NotFoundException('Alert configuration not found');
    const company = await this.loadCompanyRef(row.companyId);
    return toDto(row, company);
  }

  async create(
    actor: AuthedUser,
    input: AlertConfigInput,
    meta: RequestMeta,
  ): Promise<AlertConfig> {
    const data = sanitiseForPersist(input);
    const row = await this.prisma.alertConfig.create({
      data: {
        ...data,
        createdBy: actor.id,
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.alert.create,
      entityType: 'AlertConfig',
      entityId: row.id,
      companyId: row.companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: toAuditPayload(row),
    });
    await this.emitter.invalidate();
    const company = await this.loadCompanyRef(row.companyId);
    return toDto(row, company);
  }

  async update(
    actor: AuthedUser,
    id: string,
    patch: AlertConfigPatch,
    meta: RequestMeta,
  ): Promise<AlertConfig> {
    const before = await this.prisma.alertConfig.findFirst({
      where: { id, archivedAt: null },
    });
    if (!before) throw new NotFoundException('Alert configuration not found');

    // Merge then re-validate the full envelope so per-type required
    // fields stay consistent even after a partial PATCH (e.g. flipping
    // type from RECORD_EVENT to SINGLE_EXPIRATION must now require
    // triggerDays).
    const merged: AlertConfigInput = alertConfigInputSchema.parse({
      name: patch.name ?? before.name,
      type: (patch.type ?? before.type) as AlertType,
      enabled: patch.enabled ?? before.enabled,
      recipientEmails: patch.recipientEmails ?? before.recipientEmails,
      companyId:
        patch.companyId === undefined ? before.companyId : patch.companyId,
      triggerDays:
        patch.triggerDays === undefined ? before.triggerDays : patch.triggerDays,
      stopAfterTrigger: patch.stopAfterTrigger ?? before.stopAfterTrigger,
      expirationKinds: (patch.expirationKinds ??
        before.expirationKinds) as AlertExpirationKind[],
      recordEntityTypes: (patch.recordEntityTypes ??
        before.recordEntityTypes) as AlertRecordEntityType[],
      recordActions: (patch.recordActions ??
        before.recordActions) as AlertRecordAction[],
    });

    const data = sanitiseForPersist(merged);
    const after = await this.prisma.alertConfig.update({
      where: { id },
      data,
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.alert.update,
      entityType: 'AlertConfig',
      entityId: id,
      companyId: after.companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: toAuditPayload(before),
      after: toAuditPayload(after),
    });
    await this.emitter.invalidate();
    const company = await this.loadCompanyRef(after.companyId);
    return toDto(after, company);
  }

  async archive(
    actor: AuthedUser,
    id: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const row = await this.prisma.alertConfig.findFirst({
      where: { id, archivedAt: null },
    });
    if (!row) throw new NotFoundException('Alert configuration not found');

    await this.prisma.alertConfig.update({
      where: { id },
      data: { archivedAt: new Date(), enabled: false },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.alert.archive,
      entityType: 'AlertConfig',
      entityId: id,
      companyId: row.companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: toAuditPayload(row),
      after: null,
    });
    await this.emitter.invalidate();
    return { ok: true };
  }

  /**
   * Resolve one company ref for the DTO. Returns null when the alert
   * is unscoped, or when the referenced company has been hard-deleted
   * (defensive — the FK is not enforced because there's no Prisma
   * relation, so we degrade gracefully instead of throwing).
   */
  private async loadCompanyRef(
    companyId: string | null,
  ): Promise<AlertConfigCompanyRef | null> {
    if (!companyId) return null;
    const map = await this.loadCompanyRefs([companyId]);
    return map.get(companyId) ?? null;
  }

  /**
   * Bulk-load company refs for the list view in a single query. Uses
   * a Map keyed by id so callers can do a constant-time lookup per
   * alert row. De-dupes / filters nulls in the input array so the
   * caller can pass `rows.map((r) => r.companyId)` directly.
   */
  private async loadCompanyRefs(
    companyIds: ReadonlyArray<string | null>,
  ): Promise<Map<string, AlertConfigCompanyRef>> {
    const unique = Array.from(
      new Set(companyIds.filter((id): id is string => !!id)),
    );
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.company.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, slug: true, archivedAt: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          slug: r.slug,
          archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
        },
      ]),
    );
  }

  /**
   * Send a synthetic test email using the saved config's settings.
   * Useful for verifying SMTP delivery + recipient address before
   * waiting on a real trigger. Failures surface as 400s with the
   * underlying SMTP error so admins don't have to dig through logs.
   */
  async sendTest(
    actor: AuthedUser,
    id: string,
    input: AlertTestInput,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const row = await this.prisma.alertConfig.findFirst({
      where: { id, archivedAt: null },
    });
    if (!row) throw new NotFoundException('Alert configuration not found');
    const recipients = input.recipients ?? row.recipientEmails;
    if (recipients.length === 0) {
      throw new BadRequestException(
        'Alert configuration has no recipients to test against.',
      );
    }

    const subject = `[Weavestream] Test alert — ${row.name}`;
    const text = [
      `This is a test email triggered from the alert configuration "${row.name}".`,
      `Type: ${row.type}`,
      'No real trigger occurred — receiving this email confirms SMTP is delivering correctly.',
    ].join('\n');

    let success = false;
    let error: string | null = null;
    try {
      await this.email.send({
        to: recipients,
        subject,
        text,
        html: `<p>${text.replace(/\n/g, '<br />')}</p>`,
      });
      success = true;
      return { ok: true };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Test email failed: ${error}`);
    } finally {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.alert.test,
        entityType: 'AlertConfig',
        entityId: id,
        companyId: row.companyId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: { recipients, success, error },
      });
    }
  }
}

/**
 * Strip per-type fields that are not relevant to the chosen `type`
 * before persisting. Keeps the row clean — e.g. an EXPIRATION_LIST
 * config never carries leftover `recordActions` from a prior type.
 */
function sanitiseForPersist(input: AlertConfigInput) {
  const expirationLike =
    input.type === 'SINGLE_EXPIRATION' || input.type === 'EXPIRATION_LIST';
  const recordLike = input.type === 'RECORD_EVENT';
  const passwordLike = input.type === 'PASSWORD_EVENT';

  return {
    name: input.name,
    type: input.type,
    enabled: input.enabled,
    recipientEmails: input.recipientEmails,
    companyId: input.companyId ?? null,
    triggerDays: expirationLike ? input.triggerDays : null,
    stopAfterTrigger: expirationLike ? input.stopAfterTrigger : false,
    expirationKinds: expirationLike ? input.expirationKinds : [],
    recordEntityTypes: recordLike ? input.recordEntityTypes : [],
    recordActions:
      recordLike || passwordLike ? input.recordActions : [],
  };
}

function toDto(
  row: AlertConfigRow,
  company: AlertConfigCompanyRef | null,
): AlertConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type as AlertType,
    enabled: row.enabled,
    recipientEmails: row.recipientEmails,
    companyId: row.companyId,
    company,
    triggerDays: row.triggerDays,
    stopAfterTrigger: row.stopAfterTrigger,
    expirationKinds: row.expirationKinds as AlertExpirationKind[],
    recordEntityTypes: row.recordEntityTypes as AlertRecordEntityType[],
    recordActions: row.recordActions as AlertRecordAction[],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAuditPayload(row: AlertConfigRow) {
  return {
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    recipientEmails: row.recipientEmails,
    companyId: row.companyId,
    triggerDays: row.triggerDays,
    stopAfterTrigger: row.stopAfterTrigger,
    expirationKinds: row.expirationKinds,
    recordEntityTypes: row.recordEntityTypes,
    recordActions: row.recordActions,
  };
}
