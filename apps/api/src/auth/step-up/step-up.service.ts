import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { StepUpFactor, StepUpStatus } from '@weavestream/shared';
import { RedisService } from '../../redis/redis.service.js';
import { EnvService } from '../../config/env.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import type { AuthedUser } from '../../common/current-user.decorator.js';
import { PasswordService } from '../password.service.js';
import { MfaService } from '../mfa.service.js';
import { MfaBackupCodeService } from '../mfa-backup-code.service.js';

/**
 * Step-up (re-authentication) state, shared by `StepUpGuard` and the
 * `StepUpController`.
 *
 * The proof of a fresh credential confirmation lives in Redis keyed by
 * SESSION id with a short TTL (`STEP_UP_TTL_SEC`) — ephemeral by design
 * (no DB migration) and naturally bound to the one browser session.
 *
 * Brute-force protection uses a DEDICATED counter namespace
 * (`stepup:fail:<userId>`), intentionally separate from the login
 * lockout (`login:fail:*`) so a stolen session cannot fail step-up
 * repeatedly to lock the legitimate user out of normal sign-in.
 */
@Injectable()
export class StepUpService {
  private readonly log = new Logger(StepUpService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
    private readonly backupCodes: MfaBackupCodeService,
  ) {}

  // ── Redis-backed step-up window (keyed by session id) ───────────────

  async isVerified(sessionId: string): Promise<boolean> {
    const v = await this.redis.client.get(this.key(sessionId));
    return v !== null;
  }

  async markVerified(sessionId: string, factor: StepUpFactor): Promise<void> {
    await this.redis.client.set(
      this.key(sessionId),
      factor,
      'EX',
      this.env.values.STEP_UP_TTL_SEC,
    );
  }

  /** Best-effort cleanup on logout / session revoke. TTL is the backstop. */
  async clear(sessionId: string): Promise<void> {
    await this.redis.client.del(this.key(sessionId)).catch(() => undefined);
  }

  async status(user: AuthedUser): Promise<StepUpStatus> {
    const [verified, factor, ttl] = await Promise.all([
      this.isVerified(user.sessionId),
      this.requiredFactor(user.id),
      this.redis.client.ttl(this.key(user.sessionId)),
    ]);
    return { verified, factor, expiresInSec: ttl > 0 ? ttl : 0 };
  }

  /**
   * Single source of truth for which credential a step-up requires.
   * Both the guard and `verify()` derive the factor from this so they
   * can never disagree. `mfaEnabled` with a stored secret → `mfa`;
   * everything else (including the should-never-happen inconsistent
   * state) → `password`.
   */
  async requiredFactor(userId: string): Promise<StepUpFactor> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaEnabled: true, mfaSecretEncrypted: true },
    });
    return this.factorOf(row);
  }

  /**
   * The one place that decides 'mfa' vs 'password'. Both `requiredFactor`
   * (guard path) and `verify` call this so the challenge the client is
   * told to satisfy and the credential the server actually checks can
   * never drift apart.
   */
  private factorOf(
    row: { mfaEnabled: boolean; mfaSecretEncrypted: string | null } | null,
  ): StepUpFactor {
    return row?.mfaEnabled && row.mfaSecretEncrypted ? 'mfa' : 'password';
  }

  // ── Verification ────────────────────────────────────────────────────

  /**
   * Re-confirm a credential and open the step-up window for this
   * session. Validates the strongest factor the account has (a fresh
   * TOTP / backup code when MFA is enabled, otherwise the password).
   * Generic failures only — never reveal which factor or why.
   */
  async verify(
    user: AuthedUser,
    code: string,
    meta: { ip: string; userAgent: string },
  ): Promise<{ ok: true }> {
    // An MFA-pending session hasn't cleared the login second factor and
    // can never grant a step-up.
    if (user.mfaPending) {
      throw new ForbiddenException('Complete sign-in before confirming');
    }

    if (await this.isFailLocked(user.id)) {
      throw new HttpException(
        'Too many failed attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true, mfaEnabled: true, mfaSecretEncrypted: true },
    });
    if (!row) throw new UnauthorizedException();

    const factor = this.factorOf(row);
    let method: 'totp' | 'backup_code' | 'password';
    let ok = false;

    if (factor === 'mfa') {
      method = 'totp';
      const secret = this.mfa.decryptSecret(row.mfaSecretEncrypted!);
      if (this.mfa.verify(code, secret)) {
        ok = true;
      } else if (await this.backupCodes.consume(user.id, code)) {
        method = 'backup_code';
        ok = true;
      }
    } else {
      method = 'password';
      if (row.mfaEnabled && !row.mfaSecretEncrypted) {
        // Inconsistent state: MFA flagged on but no secret stored. Reset
        // clears both together, so this should never happen. Fall back
        // to password (don't brick the admin) but flag it loudly.
        this.log.error(
          `User ${user.id} has mfaEnabled with no stored secret; using password step-up`,
        );
        await this.audit.log({
          actorId: user.id,
          action: AUDIT_ACTIONS.security.stepUpAnomaly,
          entityType: 'User',
          entityId: user.id,
          ip: meta.ip,
          userAgent: meta.userAgent,
          before: null,
          after: { reason: 'mfa_enabled_without_secret' },
        });
      }
      ok = await this.passwords.verify(row.passwordHash, code);
    }

    if (!ok) {
      const failureCount = await this.recordFailure(user.id);
      await this.audit.log({
        actorId: user.id,
        action: AUDIT_ACTIONS.security.stepUpFailed,
        entityType: 'Session',
        entityId: user.sessionId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          factor,
          sessionId: user.sessionId,
          failureCount: failureCount ?? null,
        },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.clearFailures(user.id);
    await this.markVerified(user.sessionId, factor);
    await this.audit.log({
      actorId: user.id,
      action: AUDIT_ACTIONS.security.stepUpVerified,
      entityType: 'Session',
      entityId: user.sessionId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { factor, method, sessionId: user.sessionId },
    });
    return { ok: true };
  }

  // ── Dedicated step-up failure counter (decoupled from login) ────────

  private async isFailLocked(userId: string): Promise<boolean> {
    const hits = await this.redis.client.get(this.failKey(userId));
    return parseInt(hits ?? '0', 10) >= this.env.values.LOCKOUT_MAX_FAILURES;
  }

  /**
   * INCR + sliding EXPIRE, returning the post-increment count so the
   * `security.stepup.failed` audit payload can carry it (the alert
   * emitter fires "suspicious account behavior" when it reaches
   * `LOCKOUT_MAX_FAILURES`).
   *
   * FAILS CLOSED (throws) on any transaction or reply failure — the
   * counter write is lockout enforcement, so a failed attempt must not
   * slide through uncounted, and a failed EXPIRE must not leave a
   * TTL-less counter that would eventually lock the user out
   * permanently (the fast-fail 429 branch runs before the on-success
   * clearing path). On a bad reply the key is best-effort deleted
   * first (self-heal), mirroring `LockoutService.settleCounter`.
   */
  private async recordFailure(userId: string): Promise<number> {
    const windowSec = this.env.values.LOCKOUT_WINDOW_MIN * 60;
    const k = this.failKey(userId);
    const multi = this.redis.client.multi();
    multi.incr(k);
    multi.expire(k, windowSec);
    let res: [error: Error | null, result: unknown][] | null;
    try {
      res = await multi.exec();
    } catch (err) {
      this.log.warn(
        `step-up failure MULTI failed — failing closed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    if (!res) {
      this.log.warn('step-up failure counter MULTI aborted — failing closed');
      throw new Error('step-up failure counter transaction aborted');
    }

    const incrErr = res[0]?.[0];
    const count = res[0]?.[1];
    const expireErr = res[1]?.[0];
    const expireReply = res[1]?.[1];
    let problem: string | null = null;
    if (incrErr || typeof count !== 'number') {
      problem = `INCR failed: ${
        incrErr instanceof Error ? incrErr.message : `unexpected reply ${String(count)}`
      }`;
    } else if (expireErr || expireReply !== 1) {
      problem = `EXPIRE failed: ${
        expireErr instanceof Error
          ? expireErr.message
          : `unexpected reply ${String(expireReply)}`
      }`;
    }
    if (problem === null) return count as number;

    this.log.warn(
      `step-up failure counter ${k} ${problem} — deleting key and failing closed`,
    );
    await this.redis.client.del(k).catch(() => undefined);
    throw new Error(`step-up failure counter ${k}: ${problem}`);
  }

  private async clearFailures(userId: string): Promise<void> {
    await this.redis.client.del(this.failKey(userId)).catch(() => undefined);
  }

  private key(sessionId: string): string {
    return `stepup:${sessionId}`;
  }

  private failKey(userId: string): string {
    return `stepup:fail:${userId}`;
  }
}
