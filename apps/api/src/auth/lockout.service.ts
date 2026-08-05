import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../config/env.service.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Post-INCR failure counts for one login attempt. Callers embed these
 * in the `auth.login.failure` audit payload so `AlertEmitterService`
 * can fire "repeated failed sign-ins" exactly when a counter reaches
 * `LOCKOUT_MAX_FAILURES` — the moment the lockout engages — without
 * re-counting anything.
 */
export interface LoginFailureCounts {
  ip: number;
  email: number;
}

type MultiExecResult = [error: Error | null, result: unknown][] | null;

@Injectable()
export class LockoutService {
  private readonly logger = new Logger(LockoutService.name);

  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
  ) {}

  private key(kind: 'ip' | 'email', value: string): string {
    return `login:fail:${kind}:${value.toLowerCase()}`;
  }

  /**
   * Run a counter MULTI, FAILING CLOSED: a rejected or aborted
   * transaction propagates to the caller, so an authentication attempt
   * can never proceed uncounted just because Redis broke mid-request.
   * (Count enrichment for alerts is the best-effort part; the counter
   * write is enforcement and is not.)
   */
  private async execCounterMulti(
    multi: { exec(): Promise<MultiExecResult> },
    label: string,
  ): Promise<NonNullable<MultiExecResult>> {
    let res: MultiExecResult;
    try {
      res = await multi.exec();
    } catch (err) {
      this.logger.warn(
        `${label} counter MULTI failed — failing closed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    if (!res) {
      this.logger.warn(`${label} counter MULTI aborted — failing closed`);
      throw new Error(`${label} failure counter transaction aborted`);
    }
    return res;
  }

  /**
   * Validate one counter's INCR + EXPIRE replies. Any failure means the
   * counter is not in a trustworthy state:
   *
   *  - a failed INCR (e.g. non-integer garbage in the key) means the
   *    attempt was not counted;
   *  - a failed EXPIRE means the key has no TTL — it would accumulate
   *    forever and, once past the threshold, lock the subject out
   *    PERMANENTLY, because the fast-fail 429 branch runs before the
   *    on-success clearing path can ever be reached.
   *
   * In both cases the key is best-effort deleted (self-heal: better a
   * reset counter than a corrupt or immortal one) and an Error is
   * returned for the caller to throw — fail closed.
   */
  private async settleCounter(
    res: NonNullable<MultiExecResult>,
    incrIndex: number,
    expireIndex: number,
    key: string,
  ): Promise<number | Error> {
    const incrErr = res[incrIndex]?.[0];
    const count = res[incrIndex]?.[1];
    const expireErr = res[expireIndex]?.[0];
    const expireReply = res[expireIndex]?.[1];

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

    this.logger.warn(
      `failure counter ${key} ${problem} — deleting key and failing closed`,
    );
    await this.redis.client.del(key).catch(() => undefined);
    return new Error(`failure counter ${key}: ${problem}`);
  }

  async isLocked(ip: string, email: string): Promise<boolean> {
    const { LOCKOUT_MAX_FAILURES } = this.env.values;
    const [ipHits, emailHits] = await Promise.all([
      this.redis.client.get(this.key('ip', ip)),
      this.redis.client.get(this.key('email', email)),
    ]);
    return (
      parseInt(ipHits ?? '0', 10) >= LOCKOUT_MAX_FAILURES ||
      parseInt(emailHits ?? '0', 10) >= LOCKOUT_MAX_FAILURES
    );
  }

  /**
   * Record one failed login and return the post-increment counts (the
   * MULTI computed them all along; previously the replies were
   * discarded). Throws — failing the authentication request closed —
   * when the transaction or any INCR/EXPIRE reply is unusable: the
   * counter write is lockout ENFORCEMENT, and an attempt must never
   * slide through uncounted or leave a TTL-less counter behind.
   */
  async recordFailure(ip: string, email: string): Promise<LoginFailureCounts> {
    const windowSec = this.env.values.LOCKOUT_WINDOW_MIN * 60;
    const ipKey = this.key('ip', ip);
    const emailKey = this.key('email', email);
    const multi = this.redis.client.multi();
    multi.incr(ipKey);
    multi.expire(ipKey, windowSec);
    multi.incr(emailKey);
    multi.expire(emailKey, windowSec);
    const res = await this.execCounterMulti(multi, 'login');

    const ipResult = await this.settleCounter(res, 0, 1, ipKey);
    const emailResult = await this.settleCounter(res, 2, 3, emailKey);
    if (ipResult instanceof Error) throw ipResult;
    if (emailResult instanceof Error) throw emailResult;
    return { ip: ipResult, email: emailResult };
  }

  async clear(ip: string, email: string): Promise<void> {
    await Promise.all([
      this.redis.client.del(this.key('ip', ip)),
      this.redis.client.del(this.key('email', email)),
    ]);
  }

  // ── Dedicated MFA-verify failure counter ────────────────────────────
  // Keyed on userId alone, in its own namespace. MFA verify already runs
  // against an authenticated (mfaPending) session, so the user is the
  // right principal — never IP or email. Keeping it per-user (and out of
  // the shared login `email` bucket) means one user's failed codes cannot
  // lock out anyone else, and avoids the shared-NAT lockout that an IP
  // counter would reintroduce. Mirrors StepUpService's per-user counter.

  private mfaKey(userId: string): string {
    return `mfa:fail:${userId}`;
  }

  async isMfaLocked(userId: string): Promise<boolean> {
    const hits = await this.redis.client.get(this.mfaKey(userId));
    return parseInt(hits ?? '0', 10) >= this.env.values.LOCKOUT_MAX_FAILURES;
  }

  async recordMfaFailure(userId: string): Promise<number> {
    return this.recordSingleCounterFailure(this.mfaKey(userId), 'mfa');
  }

  async clearMfaFailures(userId: string): Promise<void> {
    await this.redis.client.del(this.mfaKey(userId));
  }

  // ── Dedicated change-password failure counter ───────────────────────
  // Keyed on userId alone, in its own namespace. Change-password re-checks
  // the current password against an already-authenticated session, so the
  // user is the right principal — never IP or email. A separate namespace
  // (out of the shared login `email` bucket) means grinding the current
  // password on this endpoint cannot lock the legitimate user out of normal
  // sign-in. Mirrors StepUpService's per-user counter.

  private changePasswordKey(userId: string): string {
    return `changepw:fail:${userId}`;
  }

  async isChangePasswordLocked(userId: string): Promise<boolean> {
    const hits = await this.redis.client.get(this.changePasswordKey(userId));
    return parseInt(hits ?? '0', 10) >= this.env.values.LOCKOUT_MAX_FAILURES;
  }

  async recordChangePasswordFailure(userId: string): Promise<number> {
    return this.recordSingleCounterFailure(this.changePasswordKey(userId), 'changepw');
  }

  async clearChangePasswordFailures(userId: string): Promise<void> {
    await this.redis.client.del(this.changePasswordKey(userId));
  }

  /**
   * INCR + sliding EXPIRE for the per-user counters (MFA / change-
   * password), returning the post-increment count. Fails closed (throws)
   * on any transaction or reply failure — see `settleCounter` for why a
   * bad EXPIRE in particular must never be ignored.
   */
  private async recordSingleCounterFailure(
    key: string,
    label: string,
  ): Promise<number> {
    const windowSec = this.env.values.LOCKOUT_WINDOW_MIN * 60;
    const multi = this.redis.client.multi();
    multi.incr(key);
    multi.expire(key, windowSec);
    const res = await this.execCounterMulti(multi, label);
    const result = await this.settleCounter(res, 0, 1, key);
    if (result instanceof Error) throw result;
    return result;
  }
}
