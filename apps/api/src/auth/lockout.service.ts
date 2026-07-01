import { Injectable } from '@nestjs/common';
import { EnvService } from '../config/env.service.js';
import { RedisService } from '../redis/redis.service.js';

@Injectable()
export class LockoutService {
  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
  ) {}

  private key(kind: 'ip' | 'email', value: string): string {
    return `login:fail:${kind}:${value.toLowerCase()}`;
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

  async recordFailure(ip: string, email: string): Promise<void> {
    const windowSec = this.env.values.LOCKOUT_WINDOW_MIN * 60;
    const multi = this.redis.client.multi();
    multi.incr(this.key('ip', ip));
    multi.expire(this.key('ip', ip), windowSec);
    multi.incr(this.key('email', email));
    multi.expire(this.key('email', email), windowSec);
    await multi.exec();
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

  async recordMfaFailure(userId: string): Promise<void> {
    const windowSec = this.env.values.LOCKOUT_WINDOW_MIN * 60;
    const key = this.mfaKey(userId);
    const multi = this.redis.client.multi();
    multi.incr(key);
    multi.expire(key, windowSec);
    await multi.exec();
  }

  async clearMfaFailures(userId: string): Promise<void> {
    await this.redis.client.del(this.mfaKey(userId));
  }
}
