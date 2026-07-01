import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { UiTheme, UiAccent } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { MfaService } from './mfa.service.js';
import { MfaBackupCodeService } from './mfa-backup-code.service.js';
import { LockoutService } from './lockout.service.js';
import { StepUpService } from './step-up/step-up.service.js';
import { EnvService } from '../config/env.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { SetupTokenService } from '../users/setup-token.service.js';
import { themeFromDb, accentFromDb } from './ui-preferences.mapping.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * A refresh token that was just rotated away is remembered for one
 * generation so a benign concurrent refresh — two tabs or several in-flight
 * requests racing on the same cookie — can still be served. The retired
 * token presented within this window yields a fresh access token only (no
 * re-rotation); presented later it is treated as reuse/theft and the session
 * is revoked. Server-owned tunable, deliberately not an env var.
 */
const REFRESH_REUSE_LEEWAY_SEC = 15;

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  mfaSetupRequired: boolean;
  mfaChallengeRequired: boolean;
  user: { id: string; email: string; name: string; role: string };
  preferences: { uiTheme: UiTheme; uiAccent: UiAccent };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mfa: MfaService,
    private readonly backupCodes: MfaBackupCodeService,
    private readonly lockout: LockoutService,
    private readonly stepUp: StepUpService,
    private readonly env: EnvService,
    private readonly audit: AuditLogService,
    private readonly setupTokens: SetupTokenService,
  ) {}

  private readonly logger = new Logger(AuthService.name);

  async login(
    email: string,
    password: string,
    ip: string,
    userAgent: string,
  ): Promise<LoginResult> {
    if (await this.lockout.isLocked(ip, email)) {
      // Neutral message; never leak whether the user exists.
      throw new HttpException(
        'Too many failed attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    const ok =
      !!user && user.isActive && (await this.passwords.verify(user.passwordHash, password));

    if (!ok) {
      await this.lockout.recordFailure(ip, email);
      await this.audit.log({
        actorId: user?.id ?? null,
        action: 'auth.login.failure',
        entityType: 'User',
        entityId: user?.id ?? null,
        ip,
        userAgent,
        before: null,
        after: { attemptedEmail: email },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.lockout.clear(ip, email);

    const mfaSetupRequired = user.mfaEnforcementCompletedAt === null;
    const mfaChallengeRequired = !mfaSetupRequired && user.mfaEnabled;

    const refresh = this.tokens.mintRefreshToken();
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: refresh.hash,
        mfaPending: mfaChallengeRequired,
        ip,
        userAgent,
        expiresAt: new Date(
          Date.now() + this.env.values.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
        ),
      },
    });

    const accessToken = await this.tokens.issueAccessToken({
      sub: user.id,
      sid: session.id,
      role: user.role,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.log({
      actorId: user.id,
      action: 'auth.login.success',
      entityType: 'Session',
      entityId: session.id,
      ip,
      userAgent,
      before: null,
      after: { mfaPending: mfaChallengeRequired, mfaSetupRequired },
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      mfaSetupRequired,
      mfaChallengeRequired,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      preferences: {
        uiTheme: themeFromDb(user.uiTheme),
        uiAccent: accentFromDb(user.uiAccent),
      },
    };
  }

  async logout(sessionId: string, actorId: string, ip: string, userAgent: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Drop any step-up window bound to this session (TTL is the backstop).
    await this.stepUp.clear(sessionId);
    await this.audit.log({
      actorId,
      action: 'auth.logout',
      entityType: 'Session',
      entityId: sessionId,
      ip,
      userAgent,
      before: null,
      after: null,
    });
  }

  async enrollMfa(user: AuthedUser, ip: string, userAgent: string) {
    if (user.mfaEnforcementCompletedAt !== null) {
      throw new BadRequestException('MFA already enrolled; use reset-mfa CLI to re-enroll');
    }

    // Re-use an in-progress secret instead of regenerating. React
    // Strict Mode (dev) double-fires the setup page's mount effect,
    // and a real user may also refresh the page after scanning the
    // QR. Both paths previously rotated the DB secret while the
    // authenticator app still held the old one — every subsequent
    // verify failed until lockout. Once `mfaEnforcementCompletedAt`
    // is set we go through `resetMfa` instead, so the only window
    // where we hand out the same secret twice is between the first
    // enroll and a successful verify.
    const existing = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { mfaSecretEncrypted: true },
    });

    let secret: string;
    let isFresh: boolean;
    if (existing?.mfaSecretEncrypted) {
      secret = this.mfa.decryptSecret(existing.mfaSecretEncrypted);
      isFresh = false;
    } else {
      secret = this.mfa.generateSecret();
      const encrypted = this.mfa.encryptSecret(secret);
      await this.prisma.user.update({
        where: { id: user.id },
        data: { mfaSecretEncrypted: encrypted },
      });
      isFresh = true;
    }

    if (isFresh) {
      await this.audit.log({
        actorId: user.id,
        action: 'auth.mfa.enroll',
        entityType: 'User',
        entityId: user.id,
        ip,
        userAgent,
        before: null,
        after: null,
      });
    }

    const otpauthUrl = this.mfa.otpauthUrl(user.email, secret);
    const qrDataUrl = await this.mfa.qrDataUrl(otpauthUrl);
    return {
      secret,
      otpauthUrl,
      qrDataUrl,
    };
  }

  async verifyMfa(
    user: AuthedUser,
    token: string,
    ip: string,
    userAgent: string,
  ): Promise<{ backupCodes?: string[] }> {
    // MFA lockout is scoped per user (never the login email/IP buckets):
    // this path always runs against an authenticated mfaPending session, so
    // `user.id` is the correct principal and is available without a DB load,
    // keeping this fast-fail check ahead of the row fetch below.
    if (await this.lockout.isMfaLocked(user.id)) {
      throw new HttpException(
        'Too many failed attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const row = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!row?.mfaSecretEncrypted) {
      throw new BadRequestException('MFA not enrolled');
    }

    const firstTime = row.mfaEnforcementCompletedAt === null;
    const secret = this.mfa.decryptSecret(row.mfaSecretEncrypted);
    const totpOk = this.mfa.verify(token, secret);
    const backupOk = !totpOk && !firstTime
      ? await this.backupCodes.consume(user.id, token)
      : false;
    const ok = totpOk || backupOk;
    if (!ok) {
      await this.lockout.recordMfaFailure(user.id);
      await this.audit.log({
        actorId: user.id,
        action: 'auth.mfa.verify.failure',
        entityType: 'User',
        entityId: user.id,
        ip,
        userAgent,
        before: null,
        after: null,
      });
      throw new UnauthorizedException('Invalid MFA code');
    }

    await this.lockout.clearMfaFailures(user.id);

    const issuedBackupCodes = firstTime
      ? await this.backupCodes.replaceForUser(user.id)
      : undefined;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: true,
        mfaEnforcementCompletedAt: firstTime ? new Date() : row.mfaEnforcementCompletedAt,
      },
    });

    await this.prisma.session.updateMany({
      where: { id: user.sessionId, revokedAt: null },
      data: { mfaPending: false },
    });

    await this.audit.log({
      actorId: user.id,
      action: backupOk
        ? 'auth.mfa.backup.used'
        : firstTime
          ? 'auth.mfa.enroll.complete'
          : 'auth.mfa.verify.success',
      entityType: 'User',
      entityId: user.id,
      ip,
      userAgent,
      before: null,
      after: backupOk ? { sessionId: user.sessionId } : null,
    });

    return issuedBackupCodes ? { backupCodes: issuedBackupCodes } : {};
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          where: { revokedAt: null },
          select: {
            companyId: true,
            role: true,
            expiresAt: true,
          },
        },
      },
    });
    if (!user) throw new ForbiddenException();
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      globalAccess: user.globalAccess,
      platformCapabilities: user.platformCapabilities,
      mfaEnabled: user.mfaEnabled,
      mfaEnforcementCompletedAt: user.mfaEnforcementCompletedAt,
      memberships: user.memberships,
      // Phase 9b.1: appearance prefs. Exposed over the wire as lowercase
      // strings matching the CSS data-attribute values (dark/light/system
      // and lime/amber/iris/coral/teal) so the web app can assign them
      // directly without a mapping step.
      preferences: {
        uiTheme: themeFromDb(user.uiTheme),
        uiAccent: accentFromDb(user.uiAccent),
      },
    };
  }

  async inviteLookup(token: string) {
    const out = await this.setupTokens.lookup(token);
    if (!out || !out.valid) {
      return { valid: false } as const;
    }
    return {
      valid: true as const,
      email: out.row.user.email,
      name: out.row.user.name,
      expiresAt: out.row.expiresAt,
    };
  }

  async acceptInvite(
    token: string,
    newPassword: string,
    ip: string,
    userAgent: string,
  ): Promise<LoginResult> {
    const lookup = await this.setupTokens.lookup(token);
    if (!lookup || !lookup.valid) {
      throw new BadRequestException('Setup link is invalid or expired');
    }
    const user = await this.prisma.user.findUnique({ where: { id: lookup.row.userId } });
    if (!user || !user.isActive) {
      throw new BadRequestException('Setup link is invalid or expired');
    }

    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.userSetupToken.update({
        where: { id: lookup.row.id },
        data: { consumedAt: new Date() },
      });
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          // Setting password clears any previous MFA state that was
          // somehow set on a password-less user. Guarantees the user
          // is routed to /mfa/setup next.
          mfaEnabled: false,
          mfaEnforcementCompletedAt: null,
          mfaSecretEncrypted: null,
        },
      });
      await tx.userMfaBackupCode.deleteMany({ where: { userId: user.id } });
    });

    // Mint session immediately so the user bounces into /mfa/setup.
    const refresh = this.tokens.mintRefreshToken();
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: refresh.hash,
        mfaPending: false,
        ip,
        userAgent,
        expiresAt: new Date(
          Date.now() + this.env.values.SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
        ),
      },
    });
    const accessToken = await this.tokens.issueAccessToken({
      sub: user.id,
      sid: session.id,
      role: user.role,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.log({
      actorId: user.id,
      action: 'user.invite.accepted',
      entityType: 'User',
      entityId: user.id,
      ip,
      userAgent,
      before: null,
      after: { sessionId: session.id },
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      mfaSetupRequired: true,
      mfaChallengeRequired: false,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      preferences: {
        uiTheme: themeFromDb(user.uiTheme),
        uiAccent: accentFromDb(user.uiAccent),
      },
    };
  }

  /**
   * Validate a refresh token, rotate it, and mint a fresh access token.
   * Shared by the explicit `POST /auth/refresh` endpoint and the guard's
   * silent-refresh path so rotation cannot be bypassed by using one path.
   *
   * On success the caller must set the access cookie, and — when
   * `refreshToken` is present — replace the session cookie with it. A `null`
   * return means the caller should clear cookies and respond 401; any
   * security action (reuse revoke + audit) has already happened here.
   *
   * `opts.audit` controls the routine `auth.refresh` audit entry: the
   * explicit endpoint records it, the silent path does not (it fires every
   * ~15 min per active user and would flood the log). The security-critical
   * reuse event is always audited regardless.
   */
  async rotateRefresh(
    refreshToken: string,
    ip: string,
    userAgent: string,
    opts: { audit: boolean },
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    payload: { sub: string; sid: string; role: string };
  } | null> {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const now = new Date();

    // --- Active token: the happy path. Rotate it for a fresh one. ---
    const active = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: true },
    });
    if (active) {
      if (active.revokedAt || active.expiresAt < now || !active.user.isActive) {
        return null;
      }
      // Mint both tokens *before* the compare-and-swap. Issuing the access
      // JWT is the only fallible step in this branch, so doing it first means
      // a transient failure cannot retire the old refresh token and strand
      // the browser on a cookie the DB no longer recognises (which would
      // surface as a spurious logout, or a false reuse revoke when the
      // browser later retries the now-"previous" token). On a lost race the
      // freshly minted tokens are simply discarded — a cheap, harmless cost.
      const next = this.tokens.mintRefreshToken();
      const accessToken = await this.tokens.issueAccessToken({
        sub: active.userId,
        sid: active.id,
        role: active.user.role,
      });
      // Atomic compare-and-swap on the active hash: only one concurrent
      // caller can flip it. A loser sees count === 0 and falls through to
      // the previous-hash branch, where it is recognised as a benign race.
      const rotated = await this.prisma.session.updateMany({
        where: { id: active.id, refreshTokenHash: hash, revokedAt: null },
        data: {
          refreshTokenHash: next.hash,
          previousRefreshTokenHash: hash,
          rotatedAt: now,
        },
      });
      if (rotated.count === 1) {
        // The old token is now retired, so we must hand back the new cookie
        // no matter what. The routine refresh audit is therefore best-effort:
        // a logging hiccup must never convert a successful rotation into a
        // logout or a later false reuse revoke.
        if (opts.audit) {
          try {
            await this.audit.log({
              actorId: active.userId,
              action: AUDIT_ACTIONS.auth.refresh,
              entityType: 'Session',
              entityId: active.id,
              ip,
              userAgent,
              before: null,
              after: null,
            });
          } catch (err) {
            this.logger.warn(
              `Failed to audit auth.refresh for session ${active.id}: ${String(err)}`,
            );
          }
        }
        return {
          accessToken,
          refreshToken: next.token,
          payload: { sub: active.userId, sid: active.id, role: active.user.role },
        };
      }
      // count === 0 -> lost the rotation race; fall through to the
      // previous-hash branch, which now holds our token.
    }

    // --- Previous token: either a concurrent refresh or reuse/theft. ---
    const prior = await this.prisma.session.findUnique({
      where: { previousRefreshTokenHash: hash },
      include: { user: true },
    });
    if (
      !prior ||
      prior.revokedAt ||
      prior.expiresAt < now ||
      !prior.user.isActive
    ) {
      return null;
    }

    const rotatedAgoSec = prior.rotatedAt
      ? (now.getTime() - prior.rotatedAt.getTime()) / 1000
      : Infinity;
    if (rotatedAgoSec <= REFRESH_REUSE_LEEWAY_SEC) {
      // Benign concurrent refresh: the winning request already minted (and
      // set the cookie for) the new refresh token. Hand this racer a fresh
      // access token only — do not rotate again, do not touch the session
      // cookie (omitting `refreshToken` signals the caller to leave it).
      const accessToken = await this.tokens.issueAccessToken({
        sub: prior.userId,
        sid: prior.id,
        role: prior.user.role,
      });
      return {
        accessToken,
        payload: { sub: prior.userId, sid: prior.id, role: prior.user.role },
      };
    }

    // Reuse of a long-retired token -> treat as theft. Revoke the session
    // and raise a security event. The conditional update makes this
    // idempotent: only the transition to revoked audits, so a burst of stale
    // requests after revocation does not flood the audit log.
    const revoked = await this.prisma.session.updateMany({
      where: { id: prior.id, revokedAt: null },
      data: { revokedAt: now },
    });
    if (revoked.count === 1) {
      // Write the security event first — it is the whole point of reuse
      // detection and must not be lost to a downstream Redis failure.
      await this.audit.log({
        actorId: prior.userId,
        action: AUDIT_ACTIONS.auth.refreshTokenReused,
        entityType: 'Session',
        entityId: prior.id,
        ip,
        userAgent,
        before: null,
        // Never log the raw token; a short hash prefix is enough to
        // correlate the reused token across audit rows.
        after: { reason: 'rotated_token_reused', tokenHashPrefix: hash.slice(0, 12) },
      });
      // Best-effort: drop any step-up window bound to the now-revoked
      // session. The window's TTL is the backstop, so a Redis hiccup here
      // must not bubble up and mask the (already-recorded) reuse event.
      try {
        await this.stepUp.clear(prior.id);
      } catch (err) {
        this.logger.warn(
          `Failed to clear step-up window for revoked session ${prior.id}: ${String(err)}`,
        );
      }
    }
    return null;
  }
}
