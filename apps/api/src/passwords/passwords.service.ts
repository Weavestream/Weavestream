import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Password, PasswordFolder, PasswordVersion, Prisma, TotpAlgo } from '@prisma/client';
import type {
  CreatePasswordInput,
  CreatePasswordFolderInput,
  PasswordFilterInput,
  RevealPasswordInput,
  TotpConfigInput,
  UpdatePasswordFolderInput,
  UpdatePasswordInput,
} from '@weavestream/shared';
import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import { computeHibpRangeHash } from './hibp-range-hash.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import {
  SecretEncryptionService,
  passwordVaultAad,
} from '../crypto/secret-encryption.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { EnvService } from '../config/env.service.js';
import { QueuesService } from '../queues/queues.service.js';
import { StarsService } from '../stars/stars.service.js';
import { computePasswordStrength } from './password-strength.js';
import {
  canReadPassword,
  passwordReadWhereFor,
} from './password-access-policy.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

/**
 * Fields tracked in `password_versions`. Updates to any of these append
 * a new version row; updates that only touch lifecycle metadata do not.
 * Keep this list in lock-step with the migration + the plan doc.
 */
const VERSIONED_FIELDS = [
  'name',
  'username',
  'url',
  'password',
  'notes',
  'totpSecret',
  'totpAlgorithm',
  'totpDigits',
  'totpPeriod',
] as const;
export type VersionedField = (typeof VERSIONED_FIELDS)[number];

/** Summary returned by list endpoints — NEVER carries ciphertext. */
export interface SerializedPasswordSummary {
  id: string;
  companyId: string;
  folderId: string | null;
  assetId: string | null;
  name: string;
  username: string | null;
  url: string | null;
  color: string | null;
  tags: string[];
  hasTotp: boolean;
  passwordStrength: number | null;
  pwnedCount: number | null;
  lastRotatedAt: Date | null;
  rotationReminderDays: number | null;
  expiresAt: Date | null;
  visibleToClients: boolean;
  requireReasonToView: boolean;
  restrictedToUserIds: string[];
  archivedAt: Date | null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Detail shape — summary + decrypted notes + TOTP shape metadata. */
export interface SerializedPasswordDetail extends SerializedPasswordSummary {
  notes: unknown | null;
  totpAlgorithm: TotpAlgo;
  totpDigits: number;
  totpPeriod: number;
  isStarred: boolean;
}

export interface PasswordRevealPayload {
  password: string;
  totpSecret?: string;
}

export interface PasswordTotpPayload {
  code: string;
  algorithm: TotpAlgo;
  digits: number;
  period: number;
  validUntil: Date;
}

export interface SerializedPasswordVersion {
  version: number;
  changedFields: string[];
  changedBy: string;
  changedByName: string | null;
  changeReason: string | null;
  createdAt: Date;
}

export interface SerializedPasswordFolder {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PasswordAccessUser {
  id: string;
  name: string;
  email: string;
  role: 'SUPER_ADMIN' | 'OPERATOR' | 'CONTRACTOR';
  accessSource: 'super_admin' | 'membership' | 'global';
  alwaysIncluded: boolean;
}

/**
 * Phase 10 — PasswordsService.
 *
 * All secret columns are treated as opaque ciphertext. `notes` is
 * decrypted on detail GETs (authorized readers) but never on list.
 * Password + TOTP secret are only decrypted in `reveal*` (audited)
 * and `generateTotpCode` (NOT audited — see the method for why).
 *
 * Versioning: any mutation to a VERSIONED_FIELDS key appends an
 * immutable `PasswordVersion` row in the same transaction as the
 * `Password` update. Restore is forward-only — it pipes a past
 * version's decrypted contents back through `update` so normal side
 * effects (strength recompute, HIBP enqueue, audit) still run.
 */
@Injectable()
export class PasswordsService {
  private readonly logger = new Logger(PasswordsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly crypto: SecretEncryptionService,
    private readonly env: EnvService,
    private readonly queues: QueuesService,
    private readonly stars: StarsService,
  ) {}

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async list(
    actor: AuthedUser,
    companyId: string,
    filters: PasswordFilterInput = {},
  ): Promise<SerializedPasswordSummary[]> {
    const where: Prisma.PasswordWhereInput = { companyId };
    const and: Prisma.PasswordWhereInput[] = [];
    const searchOr: Prisma.PasswordWhereInput[] = [];
    if (!filters.archived) where.archivedAt = null;
    if (filters.folderId) where.folderId = filters.folderId;
    if (filters.assetId) where.assetId = filters.assetId;
    if (filters.tag) where.tags = { has: filters.tag };
    if (filters.q) {
      searchOr.push(
        { name: { contains: filters.q, mode: 'insensitive' } },
        { username: { contains: filters.q, mode: 'insensitive' } },
        { url: { contains: filters.q, mode: 'insensitive' } },
      );
    }
    if (filters.stale) {
      // Stale = either rotation reminder has elapsed since lastRotatedAt
      // or expiresAt is in the past. Done entirely in SQL to keep the
      // list query single-shot.
      // Callers pass stale=true as a coarse filter; UI refines per row.
      searchOr.push({ expiresAt: { lte: new Date() } });
    }
    if (searchOr.length > 0) and.push({ OR: searchOr });
    const accessWhere = passwordReadWhereFor(actor);
    if (Object.keys(accessWhere).length > 0) and.push(accessWhere);
    if (and.length > 0) where.AND = and;

    const rows = await this.prisma.password.findMany({
      where,
      orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
      select: this.listSelect,
    });
    return rows.map((row) => this.toSummary(row, actor));
  }

  async getDetail(
    actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<SerializedPasswordDetail> {
    const row = await this.loadForRead(actor, companyId, id);
    const notes = row.notesCiphertext
      ? this.safeDecryptNotes(row.notesCiphertext, companyId, id)
      : null;
    const isStarred = await this.stars.isStarred(actor.id, 'password', id);
    return {
      ...this.toSummary(row, actor),
      notes,
      totpAlgorithm: row.totpAlgorithm,
      totpDigits: row.totpDigits,
      totpPeriod: row.totpPeriod,
      isStarred,
    };
  }

  async listVersions(
    actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<SerializedPasswordVersion[]> {
    await this.loadForRead(actor, companyId, id);
    const rows = await this.prisma.passwordVersion.findMany({
      where: { passwordId: id, companyId },
      orderBy: { version: 'desc' },
    });
    if (rows.length === 0) return [];
    const userIds = Array.from(new Set(rows.map((r) => r.changedBy)));
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name] as const));
    return rows.map((r) => ({
      version: r.version,
      changedFields: r.changedFields,
      changedBy: r.changedBy,
      changedByName: nameById.get(r.changedBy) ?? null,
      changeReason: r.changeReason,
      createdAt: r.createdAt,
    }));
  }

  // ------------------------------------------------------------------
  // Write — create/update/archive/restore
  // ------------------------------------------------------------------

  async create(
    actor: AuthedUser,
    companyId: string,
    input: CreatePasswordInput,
    meta: AuditMeta,
  ): Promise<SerializedPasswordDetail> {
    await this.assertFolderBelongs(companyId, input.folderId ?? null);
    await this.assertAssetBelongs(companyId, input.assetId ?? null);
    let restrictedToUserIds = input.restrictedToUserIds ?? [];
    if (input.restrictedToUserIds !== undefined) {
      await this.assertCanManageInternalAccess(actor);
      restrictedToUserIds = await this.validateAndNormalizeInternalAccessUsers(
        companyId,
        input.restrictedToUserIds,
      );
    }

    // Generate the row id up front: the ciphertexts are AAD-bound to
    // `companyId + passwordId + field`, so the identity has to exist
    // before the first encrypt call.
    const passwordId = randomUUID();
    const passwordCiphertext = this.crypto.encrypt(
      input.password,
      passwordVaultAad(companyId, passwordId, 'password'),
    );
    const notesCiphertext = this.encodeNotes(
      input.notes ?? null,
      companyId,
      passwordId,
    );
    const totpBlock = input.totp
      ? {
          ciphertext: this.crypto.encrypt(
            input.totp.secret,
            passwordVaultAad(companyId, passwordId, 'totp'),
          ),
          algorithm: input.totp.algorithm,
          digits: input.totp.digits,
          period: input.totp.period,
        }
      : null;

    const strength = computePasswordStrength(input.password, [
      input.name,
      input.username ?? '',
      input.url ?? '',
    ]);

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.password.create({
        data: {
          id: passwordId,
          companyId,
          folderId: input.folderId ?? null,
          assetId: input.assetId ?? null,
          name: input.name,
          username: input.username ?? null,
          url: input.url ?? null,
          notesCiphertext,
          passwordCiphertext,
          totpSecretCiphertext: totpBlock?.ciphertext ?? null,
          totpAlgorithm: (totpBlock?.algorithm ?? 'SHA1') as TotpAlgo,
          totpDigits: totpBlock?.digits ?? 6,
          totpPeriod: totpBlock?.period ?? 30,
          passwordStrength: strength,
          lastRotatedAt: new Date(),
          rotationReminderDays: input.rotationReminderDays ?? null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          color: input.color ?? null,
          tags: input.tags ?? [],
          // Secure-by-default: when the client omits the flag, the
          // credential is private. Client-portal exposure must be an
          // explicit opt-in, never the fallback on a fast/imported create.
          visibleToClients: input.visibleToClients ?? false,
          requireReasonToView: input.requireReasonToView ?? false,
          restrictedToUserIds,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await tx.passwordVersion.create({
        data: {
          passwordId: row.id,
          companyId,
          version: 1,
          name: row.name,
          username: row.username,
          url: row.url,
          notesCiphertext: row.notesCiphertext,
          passwordCiphertext: row.passwordCiphertext,
          totpSecretCiphertext: row.totpSecretCiphertext,
          totpAlgorithm: row.totpAlgorithm,
          totpDigits: row.totpDigits,
          totpPeriod: row.totpPeriod,
          changedFields: [...VERSIONED_FIELDS],
          changedBy: actor.id,
          changeReason: 'initial version',
        },
      });
      return row;
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.password.create,
      entityType: 'Password',
      entityId: created.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        name: created.name,
        username: created.username,
        url: created.url,
        folderId: created.folderId,
        assetId: created.assetId,
        hasTotp: Boolean(created.totpSecretCiphertext),
        visibleToClients: created.visibleToClients,
        requireReasonToView: created.requireReasonToView,
        restrictedToUserIds: created.restrictedToUserIds,
      },
    });

    this.enqueuePwnedCheck(created.id, companyId, input.password);

    return {
      ...this.toSummary(created, actor),
      notes: input.notes ?? null,
      totpAlgorithm: created.totpAlgorithm,
      totpDigits: created.totpDigits,
      totpPeriod: created.totpPeriod,
      isStarred: false,
    };
  }

  async update(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: UpdatePasswordInput,
    meta: AuditMeta,
  ): Promise<SerializedPasswordDetail> {
    const existing = await this.loadForRead(actor, companyId, id);
    if (existing.archivedAt) {
      throw new BadRequestException(
        'Cannot edit an archived password — restore it first.',
      );
    }
    if (input.folderId !== undefined) {
      await this.assertFolderBelongs(companyId, input.folderId);
    }
    if (input.assetId !== undefined) {
      await this.assertAssetBelongs(companyId, input.assetId);
    }
    let restrictedToUserIds = input.restrictedToUserIds;
    if (input.restrictedToUserIds !== undefined) {
      await this.assertCanManageInternalAccess(actor);
      restrictedToUserIds = await this.validateAndNormalizeInternalAccessUsers(
        companyId,
        input.restrictedToUserIds,
      );
    }

    // Build the next-value map + changedFields (versioned subset).
    const data: Prisma.PasswordUncheckedUpdateManyInput = { updatedBy: actor.id };
    const changedFields: VersionedField[] = [];

    if (input.name !== undefined && input.name !== existing.name) {
      data.name = input.name;
      changedFields.push('name');
    }
    if (input.username !== undefined && (input.username ?? null) !== existing.username) {
      data.username = input.username ?? null;
      changedFields.push('username');
    }
    if (input.url !== undefined && (input.url ?? null) !== existing.url) {
      data.url = input.url ?? null;
      changedFields.push('url');
    }
    if (input.password !== undefined) {
      data.passwordCiphertext = this.crypto.encrypt(
        input.password,
        passwordVaultAad(companyId, id, 'password'),
      );
      data.lastRotatedAt = new Date();
      data.passwordStrength = computePasswordStrength(input.password, [
        (input.name ?? existing.name) ?? '',
        (input.username ?? existing.username) ?? '',
        (input.url ?? existing.url) ?? '',
      ]);
      changedFields.push('password');
    }
    if (input.notes !== undefined) {
      data.notesCiphertext = this.encodeNotes(input.notes, companyId, id);
      changedFields.push('notes');
    }
    if (input.totp !== undefined) {
      if (input.totp === null) {
        data.totpSecretCiphertext = null;
        data.totpAlgorithm = 'SHA1';
        data.totpDigits = 6;
        data.totpPeriod = 30;
        if (existing.totpSecretCiphertext) changedFields.push('totpSecret');
      } else {
        const block: TotpConfigInput = input.totp;
        data.totpSecretCiphertext = this.crypto.encrypt(
          block.secret,
          passwordVaultAad(companyId, id, 'totp'),
        );
        data.totpAlgorithm = block.algorithm;
        data.totpDigits = block.digits;
        data.totpPeriod = block.period;
        changedFields.push('totpSecret');
        if (block.algorithm !== existing.totpAlgorithm)
          changedFields.push('totpAlgorithm');
        if (block.digits !== existing.totpDigits) changedFields.push('totpDigits');
        if (block.period !== existing.totpPeriod) changedFields.push('totpPeriod');
      }
    }

    // Lifecycle metadata — never versioned, only audit-diffed.
    const metaChanges: Record<string, unknown> = {};
    if (input.folderId !== undefined && (input.folderId ?? null) !== existing.folderId) {
      data.folderId = input.folderId ?? null;
      metaChanges.folderId = input.folderId ?? null;
    }
    if (input.assetId !== undefined && (input.assetId ?? null) !== existing.assetId) {
      data.assetId = input.assetId ?? null;
      metaChanges.assetId = input.assetId ?? null;
    }
    if (input.color !== undefined && (input.color ?? null) !== existing.color) {
      data.color = input.color ?? null;
      metaChanges.color = input.color ?? null;
    }
    if (input.tags !== undefined) {
      data.tags = input.tags;
      metaChanges.tags = input.tags;
    }
    if (
      input.visibleToClients !== undefined &&
      input.visibleToClients !== existing.visibleToClients
    ) {
      data.visibleToClients = input.visibleToClients;
      metaChanges.visibleToClients = input.visibleToClients;
    }
    if (
      input.requireReasonToView !== undefined &&
      input.requireReasonToView !== existing.requireReasonToView
    ) {
      data.requireReasonToView = input.requireReasonToView;
      metaChanges.requireReasonToView = input.requireReasonToView;
    }
    if (restrictedToUserIds !== undefined) {
      data.restrictedToUserIds = restrictedToUserIds;
      metaChanges.restrictedToUserIds = restrictedToUserIds;
    }
    if (
      input.rotationReminderDays !== undefined &&
      (input.rotationReminderDays ?? null) !== existing.rotationReminderDays
    ) {
      data.rotationReminderDays = input.rotationReminderDays ?? null;
      metaChanges.rotationReminderDays = input.rotationReminderDays ?? null;
    }
    if (input.expiresAt !== undefined) {
      const next = input.expiresAt ? new Date(input.expiresAt) : null;
      const prev = existing.expiresAt?.toISOString() ?? null;
      const nextIso = next?.toISOString() ?? null;
      if (prev !== nextIso) {
        data.expiresAt = next;
        metaChanges.expiresAt = nextIso;
      }
    }

    const touchedKeys = Object.keys(data).filter((k) => k !== 'updatedBy');
    if (touchedKeys.length === 0) {
      // Pure no-op — don't write a version or audit row.
      return this.getDetail(actor, companyId, id);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.password.updateMany({ where: { id, companyId }, data });
      const fresh = await tx.password.findFirstOrThrow({ where: { id, companyId } });
      if (changedFields.length > 0) {
        const maxVersion = await tx.passwordVersion.aggregate({
          where: { passwordId: id },
          _max: { version: true },
        });
        const nextVersion = (maxVersion._max.version ?? 0) + 1;
        await tx.passwordVersion.create({
          data: {
            passwordId: fresh.id,
            companyId,
            version: nextVersion,
            name: fresh.name,
            username: fresh.username,
            url: fresh.url,
            notesCiphertext: fresh.notesCiphertext,
            passwordCiphertext: fresh.passwordCiphertext,
            totpSecretCiphertext: fresh.totpSecretCiphertext,
            totpAlgorithm: fresh.totpAlgorithm,
            totpDigits: fresh.totpDigits,
            totpPeriod: fresh.totpPeriod,
            changedFields,
            changedBy: actor.id,
            changeReason: input.changeReason ?? null,
          },
        });
      }
      return fresh;
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.password.update,
      entityType: 'Password',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: {
        changedFields: [],
      },
      after: {
        changedFields,
        metaChanges,
        changeReason: input.changeReason ?? null,
      },
    });

    if (changedFields.includes('password') && input.password) {
      this.enqueuePwnedCheck(id, companyId, input.password);
    }

    const isStarred = await this.stars.isStarred(actor.id, 'password', id);
    return {
      ...this.toSummary(updated, actor),
      notes: updated.notesCiphertext
        ? this.safeDecryptNotes(updated.notesCiphertext, companyId, id)
        : null,
      totpAlgorithm: updated.totpAlgorithm,
      totpDigits: updated.totpDigits,
      totpPeriod: updated.totpPeriod,
      isStarred,
    };
  }

  async archive(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedPasswordSummary> {
    const existing = await this.loadForRead(actor, companyId, id);
    if (existing.archivedAt) throw new BadRequestException('Already archived');
    await this.prisma.password.updateMany({
      where: { id, companyId },
      data: { archivedAt: new Date(), updatedBy: actor.id },
    });
    const updated = await this.prisma.password.findFirstOrThrow({
      where: { id, companyId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.password.archive,
      entityType: 'Password',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: null },
      after: { archivedAt: updated.archivedAt },
    });
    return this.toSummary(updated, actor);
  }

  async restore(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedPasswordSummary> {
    const existing = await this.loadForRead(actor, companyId, id);
    if (!existing.archivedAt) throw new BadRequestException('Not archived');
    await this.prisma.password.updateMany({
      where: { id, companyId },
      data: { archivedAt: null, updatedBy: actor.id },
    });
    const updated = await this.prisma.password.findFirstOrThrow({
      where: { id, companyId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.password.restore,
      entityType: 'Password',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: existing.archivedAt },
      after: { archivedAt: null },
    });
    return this.toSummary(updated, actor);
  }

  // ------------------------------------------------------------------
  // Reveal / TOTP
  // ------------------------------------------------------------------

  async reveal(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: RevealPasswordInput,
    meta: AuditMeta,
  ): Promise<PasswordRevealPayload> {
    const row = await this.loadForReveal(actor, companyId, id);
    if (row.requireReasonToView && !input.reason) {
      throw new BadRequestException({
        error: 'ReasonRequired',
        message: 'A reason is required to reveal this credential.',
      });
    }
    const password = this.crypto.decrypt(
      row.passwordCiphertext,
      passwordVaultAad(companyId, id, 'password'),
    );
    const totpSecret =
      input.includeTotpSecret && row.totpSecretCiphertext
        ? this.crypto.decrypt(
            row.totpSecretCiphertext,
            passwordVaultAad(companyId, id, 'totp'),
          )
        : undefined;

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.password.revealed,
      entityType: 'Password',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        includedTotpSecret: Boolean(totpSecret),
        reason: input.reason ?? null,
      },
    });

    return { password, ...(totpSecret ? { totpSecret } : {}) };
  }

  async revealVersion(
    actor: AuthedUser,
    companyId: string,
    id: string,
    version: number,
    input: RevealPasswordInput,
    meta: AuditMeta,
  ): Promise<PasswordRevealPayload> {
    const row = await this.loadForReveal(actor, companyId, id);
    if (row.requireReasonToView && !input.reason) {
      throw new BadRequestException({
        error: 'ReasonRequired',
        message: 'A reason is required to reveal this credential.',
      });
    }
    const v = await this.prisma.passwordVersion.findFirst({
      where: { passwordId: id, companyId, version },
    });
    if (!v) throw new NotFoundException('version not found');
    // Version rows carry verbatim copies of the parent row's blobs, so
    // they share the parent's AAD identity.
    const password = this.crypto.decrypt(
      v.passwordCiphertext,
      passwordVaultAad(companyId, id, 'password'),
    );
    const totpSecret =
      input.includeTotpSecret && v.totpSecretCiphertext
        ? this.crypto.decrypt(
            v.totpSecretCiphertext,
            passwordVaultAad(companyId, id, 'totp'),
          )
        : undefined;
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.password.revealed,
      entityType: 'Password',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        version,
        includedTotpSecret: Boolean(totpSecret),
        reason: input.reason ?? null,
      },
    });
    return { password, ...(totpSecret ? { totpSecret } : {}) };
  }

  /**
   * Generates a fresh TOTP code for display/copy. Intentionally NOT
   * audited: the `TotpCode` UI auto-refreshes this every `period`
   * seconds while the password list or detail view is open, which
   * would otherwise flood the audit log with one row per visible TOTP
   * every ~30s. Actual user-initiated actions (reveal, copy) are
   * audited via `/reveal`, which is where the sensitive transition
   * "shared secret leaves the server" happens — the per-window code
   * is derived and short-lived, so it's treated as a view, not a
   * reveal.
   */
  async generateTotpCode(
    actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<PasswordTotpPayload> {
    const row = await this.loadForReveal(actor, companyId, id);
    if (!row.totpSecretCiphertext) {
      throw new BadRequestException('no TOTP configured');
    }
    const secret = this.crypto.decrypt(
      row.totpSecretCiphertext,
      passwordVaultAad(companyId, id, 'totp'),
    );
    // `clone()` carries the default presets (keyDecoder, createDigest,
    // etc.) from `authenticator`'s built-in defaults and merges in just
    // the overrides we need. `create({})` would drop them and throw
    // "Expecting options.keyDecoder to be a function." on generate.
    // `algorithmNameFor` only ever yields 'sha1'/'sha256'/'sha512'
    // which matches the HashAlgorithms enum otplib expects.
    const localAuth = authenticator.clone({
      algorithm: algorithmNameFor(row.totpAlgorithm),
      digits: row.totpDigits,
      step: row.totpPeriod,
    } as never);
    const code = localAuth.generate(secret);
    const now = Date.now();
    const periodMs = row.totpPeriod * 1000;
    const validUntil = new Date(Math.ceil(now / periodMs) * periodMs);

    return {
      code,
      algorithm: row.totpAlgorithm,
      digits: row.totpDigits,
      period: row.totpPeriod,
      validUntil,
    };
  }

  // ------------------------------------------------------------------
  // Version restore (forward-only)
  // ------------------------------------------------------------------

  async restoreVersion(
    actor: AuthedUser,
    companyId: string,
    id: string,
    version: number,
    meta: AuditMeta,
  ): Promise<SerializedPasswordDetail> {
    const existing = await this.loadForRead(actor, companyId, id);
    if (existing.archivedAt) {
      throw new BadRequestException(
        'Cannot restore a version on an archived password — restore the password first.',
      );
    }
    const v = await this.prisma.passwordVersion.findFirst({
      where: { passwordId: id, companyId, version },
    });
    if (!v) throw new NotFoundException('version not found');

    // Pipe vN's decrypted contents back through update() so strength
    // re-computes, HIBP re-enqueues, and a fresh version row is written
    // by the same code path as a normal edit.
    const plaintext = this.crypto.decrypt(
      v.passwordCiphertext,
      passwordVaultAad(companyId, id, 'password'),
    );
    const notes = (v.notesCiphertext
      ? this.safeDecryptNotes(v.notesCiphertext, companyId, id)
      : null) as UpdatePasswordInput['notes'];
    const totpSecret = v.totpSecretCiphertext
      ? this.crypto.decrypt(
          v.totpSecretCiphertext,
          passwordVaultAad(companyId, id, 'totp'),
        )
      : null;

    const result = await this.update(
      actor,
      companyId,
      id,
      {
        name: v.name,
        username: v.username,
        url: v.url,
        password: plaintext,
        notes,
        totp: totpSecret
          ? {
              secret: totpSecret,
              algorithm: v.totpAlgorithm,
              digits: v.totpDigits,
              period: v.totpPeriod,
            }
          : null,
        changeReason: `restore from v${version}`,
      },
      meta,
    );

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.password.versionRestored,
      entityType: 'Password',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { fromVersion: version },
    });

    return result;
  }

  async listInternalAccessUsers(
    companyId: string,
  ): Promise<PasswordAccessUser[]> {
    const now = new Date();
    const [superAdmins, memberships, globalOperators] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          isActive: true,
          role: 'SUPER_ADMIN',
        },
        select: { id: true, name: true, email: true, role: true },
      }),
      this.prisma.membership.findMany({
        where: {
          companyId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          user: {
            isActive: true,
            role: { in: ['OPERATOR', 'CONTRACTOR'] },
          },
        },
        select: {
          user: { select: { id: true, name: true, email: true, role: true } },
        },
      }),
      this.prisma.user.findMany({
        where: {
          isActive: true,
          role: 'OPERATOR',
          globalAccess: { in: ['FULL', 'READONLY'] },
        },
        select: { id: true, name: true, email: true, role: true },
      }),
    ]);

    const byId = new Map<string, PasswordAccessUser>();
    for (const user of superAdmins) {
      byId.set(user.id, {
        id: user.id,
        name: user.name,
        email: user.email,
        role: 'SUPER_ADMIN',
        accessSource: 'super_admin',
        alwaysIncluded: true,
      });
    }
    for (const membership of memberships) {
      const user = membership.user;
      byId.set(user.id, {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role as 'OPERATOR' | 'CONTRACTOR',
        accessSource: 'membership',
        alwaysIncluded: false,
      });
    }
    for (const user of globalOperators) {
      if (byId.has(user.id)) continue;
      byId.set(user.id, {
        id: user.id,
        name: user.name,
        email: user.email,
        role: 'OPERATOR',
        accessSource: 'global',
        alwaysIncluded: false,
      });
    }

    return Array.from(byId.values()).sort((a, b) => {
      if (a.alwaysIncluded !== b.alwaysIncluded) {
        return a.alwaysIncluded ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }

  // ------------------------------------------------------------------
  // Asset cascade (called from AssetsService)
  // ------------------------------------------------------------------

  async cascadeArchiveFromAsset(
    companyId: string,
    assetId: string,
    archivedAt: Date,
  ): Promise<{ archived: number }> {
    const { count } = await this.prisma.password.updateMany({
      where: { companyId, assetId, archivedAt: null },
      data: { archivedAt },
    });
    if (count > 0) {
      this.logger.log(
        `Asset ${assetId} archived → cascaded archive to ${count} linked password(s).`,
      );
    }
    return { archived: count };
  }

  async cascadeRestoreFromAsset(
    companyId: string,
    assetId: string,
  ): Promise<{ restored: number }> {
    const { count } = await this.prisma.password.updateMany({
      where: { companyId, assetId, archivedAt: { not: null } },
      data: { archivedAt: null },
    });
    return { restored: count };
  }

  // ------------------------------------------------------------------
  // Folders
  // ------------------------------------------------------------------

  async listFolders(companyId: string): Promise<SerializedPasswordFolder[]> {
    const rows = await this.prisma.passwordFolder.findMany({
      where: { companyId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return rows.map(this.toFolder);
  }

  async createFolder(
    actor: AuthedUser,
    companyId: string,
    input: CreatePasswordFolderInput,
    meta: AuditMeta,
  ): Promise<SerializedPasswordFolder> {
    if (input.parentId) {
      const parent = await this.prisma.passwordFolder.findFirst({
        where: { id: input.parentId, companyId, archivedAt: null },
      });
      if (!parent) {
        throw new BadRequestException({
          error: 'ParentNotFound',
          parentId: input.parentId,
        });
      }
    }
    const created = await this.prisma.passwordFolder.create({
      data: {
        companyId,
        parentId: input.parentId ?? null,
        name: input.name,
        icon: input.icon ?? null,
        color: input.color ?? null,
        position: input.position ?? 0,
        createdBy: actor.id,
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.password.folderCreate,
      entityType: 'PasswordFolder',
      entityId: created.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { name: created.name, parentId: created.parentId },
    });
    return this.toFolder(created);
  }

  async updateFolder(
    actor: AuthedUser,
    companyId: string,
    id: string,
    input: UpdatePasswordFolderInput,
    meta: AuditMeta,
  ): Promise<SerializedPasswordFolder> {
    const existing = await this.prisma.passwordFolder.findFirst({
      where: { id, companyId },
    });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) {
      throw new BadRequestException('Cannot edit an archived folder — restore it first.');
    }
    if (input.parentId !== undefined && input.parentId !== existing.parentId) {
      if (input.parentId) {
        const parent = await this.prisma.passwordFolder.findFirst({
          where: { id: input.parentId, companyId, archivedAt: null },
        });
        if (!parent) {
          throw new BadRequestException({
            error: 'ParentNotFound',
            parentId: input.parentId,
          });
        }
      }
      await this.assertFolderNoCycle(companyId, id, input.parentId);
    }

    const data: Prisma.PasswordFolderUncheckedUpdateManyInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.parentId !== undefined) data.parentId = input.parentId ?? null;
    if (input.icon !== undefined) data.icon = input.icon ?? null;
    if (input.color !== undefined) data.color = input.color ?? null;
    if (input.position !== undefined) data.position = input.position;

    await this.prisma.passwordFolder.updateMany({ where: { id, companyId }, data });
    const updated = await this.prisma.passwordFolder.findFirstOrThrow({
      where: { id, companyId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.password.folderUpdate,
      entityType: 'PasswordFolder',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { name: existing.name, parentId: existing.parentId },
      after: { name: updated.name, parentId: updated.parentId },
    });
    return this.toFolder(updated);
  }

  async archiveFolder(
    actor: AuthedUser,
    companyId: string,
    id: string,
    meta: AuditMeta,
  ): Promise<SerializedPasswordFolder> {
    const existing = await this.prisma.passwordFolder.findFirst({
      where: { id, companyId },
    });
    if (!existing) throw new NotFoundException();
    if (existing.archivedAt) throw new BadRequestException('Already archived');
    // Block if active children exist (mirrors article FoldersService).
    const activeChildren = await this.prisma.passwordFolder.count({
      where: { parentId: id, companyId, archivedAt: null },
    });
    if (activeChildren > 0) {
      throw new BadRequestException({
        error: 'FolderHasChildren',
        message: 'Archive or move child folders first.',
      });
    }
    await this.prisma.passwordFolder.updateMany({
      where: { id, companyId },
      data: { archivedAt: new Date() },
    });
    // Detach passwords so they don't dangle on an archived folder.
    await this.prisma.password.updateMany({
      where: { folderId: id, companyId },
      data: { folderId: null },
    });
    const updated = await this.prisma.passwordFolder.findFirstOrThrow({
      where: { id, companyId },
    });
    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.password.folderArchive,
      entityType: 'PasswordFolder',
      entityId: id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { archivedAt: null },
      after: { archivedAt: updated.archivedAt },
    });
    return this.toFolder(updated);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private readonly listSelect = {
    id: true,
    companyId: true,
    folderId: true,
    assetId: true,
    name: true,
    username: true,
    url: true,
    color: true,
    tags: true,
    totpSecretCiphertext: true,
    passwordStrength: true,
    pwnedCount: true,
    lastRotatedAt: true,
    rotationReminderDays: true,
    expiresAt: true,
    visibleToClients: true,
    requireReasonToView: true,
    restrictedToUserIds: true,
    archivedAt: true,
    createdBy: true,
    updatedBy: true,
    createdAt: true,
    updatedAt: true,
    totpAlgorithm: true,
    totpDigits: true,
    totpPeriod: true,
    notesCiphertext: false as const,
    passwordCiphertext: false as const,
  } satisfies Prisma.PasswordSelect;

  private async loadForRead(
    actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<Password> {
    const row = await this.prisma.password.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException();
    if (!canReadPassword(actor, row)) throw this.passwordAccessDenied(actor);
    return row;
  }

  private async loadForReveal(
    actor: AuthedUser,
    companyId: string,
    id: string,
  ): Promise<Password> {
    const row = await this.loadForRead(actor, companyId, id);
    if (row.archivedAt) {
      throw new BadRequestException('cannot reveal an archived password');
    }
    return row;
  }

  private toSummary = (row: {
    id: string;
    companyId: string;
    folderId: string | null;
    assetId: string | null;
    name: string;
    username: string | null;
    url: string | null;
    color: string | null;
    tags: string[];
    totpSecretCiphertext: string | null;
    passwordStrength: number | null;
    pwnedCount: number | null;
    lastRotatedAt: Date | null;
    rotationReminderDays: number | null;
    expiresAt: Date | null;
    visibleToClients: boolean;
    requireReasonToView: boolean;
    restrictedToUserIds: string[];
    archivedAt: Date | null;
    createdBy: string;
    updatedBy: string;
    createdAt: Date;
    updatedAt: Date;
  }, actor?: AuthedUser): SerializedPasswordSummary => ({
    id: row.id,
    companyId: row.companyId,
    folderId: row.folderId,
    assetId: row.assetId,
    name: row.name,
    username: row.username,
    url: row.url,
    color: row.color,
    tags: row.tags,
    hasTotp: Boolean(row.totpSecretCiphertext),
    passwordStrength: row.passwordStrength,
    pwnedCount: row.pwnedCount,
    lastRotatedAt: row.lastRotatedAt,
    rotationReminderDays: row.rotationReminderDays,
    expiresAt: row.expiresAt,
    visibleToClients: row.visibleToClients,
    requireReasonToView: row.requireReasonToView,
    restrictedToUserIds:
      actor?.role === 'CLIENT_USER' ? [] : row.restrictedToUserIds,
    archivedAt: row.archivedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  private passwordAccessDenied(actor: AuthedUser) {
    if (actor.role === 'CLIENT_USER') return new NotFoundException();
    return new ForbiddenException('you are not on this credential\'s allow-list');
  }

  private async assertCanManageInternalAccess(actor: AuthedUser): Promise<void> {
    if (actor.role === 'SUPER_ADMIN') return;
    if (actor.platformCapabilities.includes('MEMBERSHIP_MANAGE')) return;
    throw new ForbiddenException(
      'membership management permission is required to update internal access',
    );
  }

  private async validateAndNormalizeInternalAccessUsers(
    companyId: string,
    userIds: string[],
  ): Promise<string[]> {
    const uniqueIds = Array.from(new Set(userIds));
    if (uniqueIds.length !== userIds.length) {
      throw new BadRequestException('restrictedToUserIds contains duplicate users');
    }
    if (uniqueIds.length === 0) return [];

    const eligible = await this.listInternalAccessUsers(companyId);
    const eligibleIds = new Set(eligible.map((u) => u.id));
    const invalid = uniqueIds.filter((id) => !eligibleIds.has(id));
    if (invalid.length > 0) {
      throw new BadRequestException({
        error: 'InvalidInternalAccessUsers',
        message:
          'Internal access can only include active non-client users with company access.',
        userIds: invalid,
      });
    }
    for (const user of eligible) {
      if (user.alwaysIncluded && !uniqueIds.includes(user.id)) {
        uniqueIds.push(user.id);
      }
    }
    uniqueIds.sort();
    return uniqueIds;
  }

  private toFolder = (row: PasswordFolder): SerializedPasswordFolder => ({
    id: row.id,
    companyId: row.companyId,
    parentId: row.parentId,
    name: row.name,
    icon: row.icon,
    color: row.color,
    position: row.position,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  private encodeNotes(
    notes: unknown,
    companyId: string,
    passwordId: string,
  ): string | null {
    if (notes === null || notes === undefined) return null;
    const json = typeof notes === 'string' ? notes : JSON.stringify(notes);
    if (json.length === 0) return null;
    return this.crypto.encrypt(
      json,
      passwordVaultAad(companyId, passwordId, 'notes'),
    );
  }

  private safeDecryptNotes(
    blob: string,
    companyId: string,
    passwordId: string,
  ): unknown {
    try {
      const plaintext = this.crypto.decrypt(
        blob,
        passwordVaultAad(companyId, passwordId, 'notes'),
      );
      // Try to decode as JSON (Tiptap doc). If it isn't, treat as string.
      try {
        return JSON.parse(plaintext);
      } catch {
        return plaintext;
      }
    } catch (err) {
      this.logger.error(
        `Failed to decrypt notes — unknown kid or mismatched record binding: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private enqueuePwnedCheck(
    passwordId: string,
    companyId: string,
    secret: string,
  ): void {
    if (!this.env.values.HIBP_ENABLED) return;
    // SHA-1 here is mandated by the HIBP range API protocol — see
    // `hibp-range-hash.ts`. It is *not* a stored credential hash.
    const sha1Hex = computeHibpRangeHash(secret);
    void this.queues
      .enqueuePwnedCheck({
        kind: 'password',
        passwordId,
        companyId,
        sha1Hex,
      })
      .catch((err) => {
        this.logger.warn(
          `Failed to enqueue pwned-check for password ${passwordId}: ${(err as Error).message}`,
        );
      });
  }

  private async assertFolderBelongs(
    companyId: string,
    folderId: string | null | undefined,
  ): Promise<void> {
    if (!folderId) return;
    const folder = await this.prisma.passwordFolder.findFirst({
      where: { id: folderId, companyId, archivedAt: null },
      select: { id: true },
    });
    if (!folder) {
      throw new BadRequestException({
        error: 'FolderNotFound',
        folderId,
      });
    }
  }

  private async assertAssetBelongs(
    companyId: string,
    assetId: string | null | undefined,
  ): Promise<void> {
    if (!assetId) return;
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, companyId },
      select: { id: true },
    });
    if (!asset) {
      throw new BadRequestException({
        error: 'AssetNotFound',
        assetId,
      });
    }
  }

  private async assertFolderNoCycle(
    companyId: string,
    folderId: string,
    proposedParentId: string | null | undefined,
  ): Promise<void> {
    if (!proposedParentId) return;
    if (folderId === proposedParentId) {
      throw new BadRequestException({
        error: 'CyclicParent',
        message: 'A folder cannot be its own parent.',
      });
    }
    let cursor: string | null = proposedParentId;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) return;
      seen.add(cursor);
      if (cursor === folderId) {
        throw new BadRequestException({
          error: 'CyclicParent',
          message: 'Proposed parent is a descendant of this folder.',
        });
      }
      const parent: { parentId: string | null } | null = await this.prisma.passwordFolder.findFirst({
        where: { id: cursor, companyId },
        select: { parentId: true },
      });
      cursor = parent?.parentId ?? null;
    }
  }
}

function algorithmNameFor(algo: TotpAlgo): 'sha1' | 'sha256' | 'sha512' {
  switch (algo) {
    case 'SHA256':
      return 'sha256';
    case 'SHA512':
      return 'sha512';
    default:
      return 'sha1';
  }
}

/** Exposed for tests and the `cli reencrypt-passwords` command. */
export type { Password, PasswordVersion };
