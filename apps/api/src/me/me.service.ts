import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  ChangePasswordInput,
  UpdateMeInput,
  UserUiPreferencesUpdate,
} from '@weavestream/shared';
import { userSearchDefaultsSchema } from '@weavestream/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from '../auth/password.service.js';
import { MfaBackupCodeService } from '../auth/mfa-backup-code.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import {
  accentFromDb,
  accentToDb,
  themeFromDb,
  themeToDb,
} from '../auth/ui-preferences.mapping.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly backupCodes: MfaBackupCodeService,
    private readonly audit: AuditLogService,
  ) {}

  async profile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        // RBAC v2 — clients need the new axes so the web layer can
        // render UI gates without a second round-trip. `null` for
        // non-OPERATORs (the API guarantees that invariant on write).
        globalAccess: true,
        platformCapabilities: true,
        timezone: true,
        mfaEnabled: true,
        mfaEnforcementCompletedAt: true,
        searchDefaults: true,
        uiTheme: true,
        uiAccent: true,
        createdAt: true,
        lastLoginAt: true,
        memberships: {
          where: { revokedAt: null },
          select: {
            id: true,
            role: true,
            expiresAt: true,
            company: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });
    if (!user) throw new NotFoundException();
    // `searchDefaults` is a JSONB column we validate on write — this
    // serialises it through the Zod schema on read too so stale rows
    // persisted before a schema tweak can't leak malformed shapes to
    // the web client.
    const searchDefaults = user.searchDefaults
      ? userSearchDefaultsSchema.safeParse(user.searchDefaults)
      : null;
    return {
      ...user,
      searchDefaults:
        searchDefaults && searchDefaults.success ? searchDefaults.data : null,
      preferences: {
        uiTheme: themeFromDb(user.uiTheme),
        uiAccent: accentFromDb(user.uiAccent),
      },
    };
  }

  async updatePreferences(
    actor: AuthedUser,
    input: UserUiPreferencesUpdate,
    meta: { ip: string; userAgent: string },
  ): Promise<{ uiTheme: ReturnType<typeof themeFromDb>; uiAccent: ReturnType<typeof accentFromDb> }> {
    const before = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { uiTheme: true, uiAccent: true },
    });
    if (!before) throw new NotFoundException();

    const updated = await this.prisma.user.update({
      where: { id: actor.id },
      data: {
        ...(input.uiTheme !== undefined
          ? { uiTheme: themeToDb(input.uiTheme) }
          : {}),
        ...(input.uiAccent !== undefined
          ? { uiAccent: accentToDb(input.uiAccent) }
          : {}),
      },
      select: { uiTheme: true, uiAccent: true },
    });

    // Audit only if something actually changed — the update refine in
    // Zod already rejected empty payloads, but a user saving the same
    // value twice shouldn't spam the log.
    const changed =
      before.uiTheme !== updated.uiTheme ||
      before.uiAccent !== updated.uiAccent;
    if (changed) {
      await this.audit.log({
        actorId: actor.id,
        action: 'user.preferences.update',
        entityType: 'User',
        entityId: actor.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: {
          uiTheme: themeFromDb(before.uiTheme),
          uiAccent: accentFromDb(before.uiAccent),
        },
        after: {
          uiTheme: themeFromDb(updated.uiTheme),
          uiAccent: accentFromDb(updated.uiAccent),
        },
      });
    }

    return {
      uiTheme: themeFromDb(updated.uiTheme),
      uiAccent: accentFromDb(updated.uiAccent),
    };
  }

  async listSessions(userId: string, currentSessionId: string) {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
  }

  async update(
    actor: AuthedUser,
    input: UpdateMeInput,
    meta: { ip: string; userAgent: string },
  ) {
    const before = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!before) throw new NotFoundException();

    const updated = await this.prisma.user.update({
      where: { id: actor.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.searchDefaults !== undefined
          ? {
              // Prisma distinguishes SQL NULL (DbNull) from JSON null —
              // we only ever want to clear the column, never store the
              // literal JSON value `null`.
              searchDefaults:
                input.searchDefaults === null
                  ? Prisma.DbNull
                  : input.searchDefaults,
            }
          : {}),
      },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'user.update',
      entityType: 'User',
      entityId: actor.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: {
        name: before.name,
        timezone: before.timezone,
        searchDefaults: before.searchDefaults,
      },
      after: {
        name: updated.name,
        timezone: updated.timezone,
        searchDefaults: updated.searchDefaults,
      },
    });
    return updated;
  }

  async changePassword(
    actor: AuthedUser,
    input: ChangePasswordInput,
    meta: { ip: string; userAgent: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!user) throw new NotFoundException();

    const ok = await this.passwords.verify(user.passwordHash, input.currentPassword);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    if (input.currentPassword === input.newPassword) {
      throw new BadRequestException('New password must differ from current password');
    }

    const passwordHash = await this.passwords.hash(input.newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      // Keep the current session live; revoke every other session.
      await tx.session.updateMany({
        where: {
          userId: user.id,
          revokedAt: null,
          id: { not: actor.sessionId },
        },
        data: { revokedAt: new Date() },
      });
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'user.password.change',
      entityType: 'User',
      entityId: actor.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { sessionKept: actor.sessionId },
    });

    return { ok: true };
  }

  async revokeOtherSessions(
    actor: AuthedUser,
    meta: { ip: string; userAgent: string },
  ) {
    const result = await this.prisma.session.updateMany({
      where: {
        userId: actor.id,
        revokedAt: null,
        id: { not: actor.sessionId },
      },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'auth.sessions.revoke_others',
      entityType: 'User',
      entityId: actor.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { revoked: result.count },
    });
    return { revoked: result.count };
  }

  async regenerateMfaBackupCodes(
    actor: AuthedUser,
    meta: { ip: string; userAgent: string },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { mfaEnabled: true, mfaEnforcementCompletedAt: true },
    });
    if (!user) throw new NotFoundException();
    if (!user.mfaEnabled || user.mfaEnforcementCompletedAt === null || actor.mfaPending) {
      throw new BadRequestException('MFA must be enabled before backup codes can be regenerated');
    }

    const backupCodes = await this.backupCodes.replaceForUser(actor.id);
    await this.audit.log({
      actorId: actor.id,
      action: 'auth.mfa.backup.regenerate',
      entityType: 'User',
      entityId: actor.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { count: backupCodes.length },
    });

    return { backupCodes };
  }
}
