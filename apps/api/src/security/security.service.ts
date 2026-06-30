import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { EnvService } from '../config/env.service.js';
import { StepUpService } from '../auth/step-up/step-up.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Read-only Security Center backend.
 *
 * Surfaces four kinds of state for SUPER_ADMIN / SECURITY_READ holders:
 *   1. Login activity — successful and failed logins from the audit
 *      log, both as recent rows and as per-IP / per-email summaries
 *      over a rolling window.
 *   2. Active lockouts — Redis counters maintained by `LockoutService`
 *      (`login:fail:ip:*` / `login:fail:email:*`). We surface both
 *      "currently above threshold" entries (a real lock) and
 *      "warming" ones (1+ failures, not yet locked) so an operator
 *      can see attempted brute force before the lock kicks in.
 *   3. Throttle blocks — Redis keys written by
 *      `RedisThrottlerStorage` when an identity exceeds its bucket
 *      and a non-zero block duration is configured. We don't have a
 *      per-route block duration today (only the soft 60s rolling
 *      window), so this list is normally empty — it's wired up so
 *      the UI lights up the moment we add explicit blocks in a later
 *      phase.
 *   4. Active sessions — every non-revoked, non-expired Session row
 *      across users, augmented with the owner's email/name and the
 *      `mfaPending` flag.
 *
 * All Redis scans use `SCAN` (cursor-driven) with `COUNT 200`, which
 * is non-blocking even at tens of thousands of keys. Each helper has
 * a hard upper bound on returned rows so a runaway lockout storm
 * can't tip a single render into an OOM.
 */
@Injectable()
export class SecurityService {
  private readonly log = new Logger(SecurityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly env: EnvService,
    private readonly audit: AuditLogService,
    private readonly stepUp: StepUpService,
  ) {}

  // ────────────────────────────────────────────────────────────────
  // Login activity
  // ────────────────────────────────────────────────────────────────

  /**
   * Login activity in the last `windowHours` hours, plus per-IP and
   * per-email summaries derived from those rows. The window defaults
   * to 24h; the maximum is 168h (7 days) so a single render can't
   * sweep the entire audit table.
   */
  async loginActivity(windowHours: number): Promise<{
    windowHours: number;
    since: string;
    counts: { success: number; failure: number; mfaFailure: number };
    byIp: Array<LoginActivityBucket>;
    byEmail: Array<LoginActivityBucket>;
    recent: Array<LoginActivityRow>;
  }> {
    const safeWindow = Math.min(Math.max(windowHours, 1), 24 * 7);
    const since = new Date(Date.now() - safeWindow * 60 * 60 * 1000);
    const rows = await this.prisma.auditLog.findMany({
      where: {
        action: {
          in: [
            'auth.login.success',
            'auth.login.failure',
            'auth.mfa.verify.failure',
            'auth.mfa.verify.success',
          ],
        },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: RECENT_LIMIT,
      select: {
        id: true,
        action: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        actorId: true,
        actor: { select: { id: true, name: true, email: true } },
        after: true,
      },
    });

    let success = 0;
    let failure = 0;
    let mfaFailure = 0;
    const byIp = new Map<string, MutableBucket>();
    const byEmail = new Map<string, MutableBucket>();

    for (const r of rows) {
      const isSuccess =
        r.action === 'auth.login.success' || r.action === 'auth.mfa.verify.success';
      if (r.action === 'auth.login.success') success += 1;
      else if (r.action === 'auth.login.failure') failure += 1;
      else if (r.action === 'auth.mfa.verify.failure') mfaFailure += 1;

      const ipKey = (r.ip ?? 'unknown').trim() || 'unknown';
      const ipBucket = upsertBucket(byIp, ipKey, r.createdAt);
      if (isSuccess) ipBucket.success += 1;
      else ipBucket.failure += 1;

      const email = extractAttemptedEmail(r);
      if (email) {
        const emailBucket = upsertBucket(byEmail, email, r.createdAt);
        if (isSuccess) emailBucket.success += 1;
        else emailBucket.failure += 1;
      }
    }

    return {
      windowHours: safeWindow,
      since: since.toISOString(),
      counts: { success, failure, mfaFailure },
      byIp: bucketsToArray(byIp).slice(0, BUCKET_LIMIT),
      byEmail: bucketsToArray(byEmail).slice(0, BUCKET_LIMIT),
      recent: rows.slice(0, RECENT_LIMIT_RETURNED).map((r) => ({
        id: r.id,
        action: r.action,
        ip: r.ip,
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
        actorId: r.actorId,
        actor: r.actor,
        attemptedEmail: extractAttemptedEmail(r),
      })),
    };
  }

  // ────────────────────────────────────────────────────────────────
  // Active lockouts (Redis)
  // ────────────────────────────────────────────────────────────────

  async activeLockouts(): Promise<{
    threshold: number;
    windowMinutes: number;
    ip: Array<LockoutEntry>;
    email: Array<LockoutEntry>;
  }> {
    const threshold = this.env.values.LOCKOUT_MAX_FAILURES;
    const windowMinutes = this.env.values.LOCKOUT_WINDOW_MIN;
    const [ip, email] = await Promise.all([
      this.scanLockouts('login:fail:ip:'),
      this.scanLockouts('login:fail:email:'),
    ]);
    return { threshold, windowMinutes, ip, email };
  }

  private async scanLockouts(prefix: string): Promise<LockoutEntry[]> {
    const keys = await this.scanKeys(`${prefix}*`, LOCKOUT_KEY_LIMIT);
    if (keys.length === 0) return [];
    const pipeline = this.redis.client.pipeline();
    for (const k of keys) {
      pipeline.get(k);
      pipeline.ttl(k);
    }
    const results = (await pipeline.exec()) ?? [];
    const out: LockoutEntry[] = [];
    for (let i = 0; i < keys.length; i++) {
      const value = results[i * 2]?.[1] as string | null;
      const ttl = results[i * 2 + 1]?.[1] as number | null;
      const failures = parseInt(value ?? '0', 10);
      if (!Number.isFinite(failures) || failures <= 0) continue;
      const key = keys[i]!;
      const identifier = key.slice(prefix.length);
      out.push({
        identifier,
        failures,
        ttlSeconds: typeof ttl === 'number' && ttl > 0 ? ttl : null,
        locked: failures >= this.env.values.LOCKOUT_MAX_FAILURES,
      });
    }
    return out.sort((a, b) => b.failures - a.failures);
  }

  // ────────────────────────────────────────────────────────────────
  // Throttle blocks (Redis)
  // ────────────────────────────────────────────────────────────────

  async activeThrottleBlocks(): Promise<Array<ThrottleBlockEntry>> {
    const keys = await this.scanKeys('throttle-block:*', THROTTLE_KEY_LIMIT);
    if (keys.length === 0) return [];
    const pipeline = this.redis.client.pipeline();
    for (const k of keys) {
      pipeline.get(k);
      pipeline.pttl(k);
    }
    const results = (await pipeline.exec()) ?? [];
    const now = Date.now();
    const out: ThrottleBlockEntry[] = [];
    for (let i = 0; i < keys.length; i++) {
      const value = results[i * 2]?.[1] as string | null;
      const pttl = results[i * 2 + 1]?.[1] as number | null;
      if (!value) continue;
      const blockedUntil = parseInt(value, 10);
      const remainingMs =
        typeof pttl === 'number' && pttl > 0
          ? pttl
          : Math.max(blockedUntil - now, 0);
      // Key shape: `throttle-block:<throttler>:<tracker>` where
      // `<tracker>` is `user:<id>` or `ip:<addr>` written by
      // UserThrottlerGuard. Split defensively — unknown shapes still
      // surface so we don't silently drop signal.
      const stripped = keys[i]!.slice('throttle-block:'.length);
      const sepIdx = stripped.indexOf(':');
      const throttler = sepIdx > 0 ? stripped.slice(0, sepIdx) : stripped;
      const tracker = sepIdx > 0 ? stripped.slice(sepIdx + 1) : '';
      out.push({
        throttler,
        tracker,
        blockedUntil:
          Number.isFinite(blockedUntil) && blockedUntil > now
            ? new Date(blockedUntil).toISOString()
            : null,
        remainingMs,
      });
    }
    return out.sort((a, b) => b.remainingMs - a.remainingMs);
  }

  // ────────────────────────────────────────────────────────────────
  // Cross-user active sessions
  // ────────────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────
  // Egress (Phase 6) — recent SSRF / private-network blocks
  // ────────────────────────────────────────────────────────────────

  /**
   * Recent `security.egress.blocked` audit rows. Each row is one
   * outbound HTTP request that `safeFetch` refused — typically because
   * an integration baseUrl pointed at a private address, or an operator
   * pasted a localhost / 169.254 metadata URL. The result mirrors the
   * other Security Center read methods: hard-capped row count, formatted
   * for direct rendering by `<DataTable>`.
   */
  async egressBlocks(windowHours: number): Promise<{
    windowHours: number;
    since: string;
    total: number;
    recent: Array<EgressBlockRow>;
  }> {
    const safeWindow = Math.min(Math.max(windowHours, 1), 24 * 30);
    const since = new Date(Date.now() - safeWindow * 60 * 60 * 1000);
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          action: 'security.egress.blocked',
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        take: EGRESS_RETURNED,
        select: {
          id: true,
          createdAt: true,
          userAgent: true,
          after: true,
        },
      }),
      this.prisma.auditLog.count({
        where: {
          action: 'security.egress.blocked',
          createdAt: { gte: since },
        },
      }),
    ]);

    const recent: EgressBlockRow[] = rows.map((r) => {
      const after = (r.after ?? {}) as Record<string, unknown>;
      const resolved = Array.isArray(after.resolvedIps)
        ? after.resolvedIps.filter((x): x is string => typeof x === 'string')
        : [];
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        userAgent: r.userAgent ?? null,
        url: typeof after.url === 'string' ? after.url : null,
        hostname: typeof after.hostname === 'string' ? after.hostname : null,
        resolvedIps: resolved,
        reason: typeof after.reason === 'string' ? after.reason : null,
        matchedCidr:
          typeof after.matchedCidr === 'string' ? after.matchedCidr : null,
      };
    });

    return {
      windowHours: safeWindow,
      since: since.toISOString(),
      total,
      recent,
    };
  }

  async listActiveSessions(params: {
    userId?: string;
    limit?: number;
  }): Promise<Array<ActiveSessionRow>> {
    const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);
    const rows = await this.prisma.session.findMany({
      where: {
        revokedAt: null,
        expiresAt: { gt: new Date() },
        ...(params.userId ? { userId: params.userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        ip: true,
        userAgent: true,
        mfaPending: true,
        createdAt: true,
        expiresAt: true,
        userId: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            mfaEnabled: true,
            mfaEnforcementCompletedAt: true,
            isActive: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      ip: r.ip,
      userAgent: r.userAgent,
      mfaPending: r.mfaPending,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      user: {
        id: r.user.id,
        name: r.user.name,
        email: r.user.email,
        role: r.user.role,
        mfaEnabled: r.user.mfaEnabled,
        mfaEnrolled: r.user.mfaEnforcementCompletedAt !== null,
        isActive: r.user.isActive,
      },
    }));
  }

  /**
   * Revoke any session by id. Caller must already have passed the
   * `user.manage` capability check at the controller level. We don't
   * silently no-op on already-revoked or unknown ids — those raise so
   * the admin UI shows a clear error instead of a fake green checkmark.
   */
  async revokeSession(
    actor: AuthedUser,
    sessionId: string,
    meta: { ip: string; userAgent: string },
  ): Promise<{ revoked: 1 }> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.revokedAt) {
      // Already revoked — surface the same response shape so the UI
      // can refresh without showing an error, and emit the audit
      // record so we still know the admin pressed the button.
      await this.audit.log({
        actorId: actor.id,
        action: 'security.session.revoke',
        entityType: 'Session',
        entityId: session.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: { revoked: true },
        after: { revoked: true, noOp: true, targetUserId: session.userId },
      });
      return { revoked: 1 };
    }
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    // Drop any step-up window bound to the revoked session (TTL backstop).
    await this.stepUp.clear(session.id);
    await this.audit.log({
      actorId: actor.id,
      action: 'security.session.revoke',
      entityType: 'Session',
      entityId: session.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { targetUserId: session.userId },
    });
    return { revoked: 1 };
  }

  // ────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────

  /**
   * Cursor-driven SCAN with a hard cap. Production lockout / throttle
   * key counts should be tiny (a few dozen rows even under sustained
   * abuse), but we cap at `maxKeys` so a runaway redis can't crash a
   * render and so we never block on a single SCAN call long enough to
   * notice. `MATCH` is server-side; `COUNT` is a hint, not a guarantee.
   */
  private async scanKeys(pattern: string, maxKeys: number): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const res = (await this.redis.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        200,
      )) as [string, string[]];
      cursor = res[0];
      for (const k of res[1]) {
        out.push(k);
        if (out.length >= maxKeys) return out;
      }
    } while (cursor !== '0');
    return out;
  }
}

const RECENT_LIMIT = 1_000;
const RECENT_LIMIT_RETURNED = 200;
const BUCKET_LIMIT = 50;
const LOCKOUT_KEY_LIMIT = 1_000;
const THROTTLE_KEY_LIMIT = 1_000;
const EGRESS_RETURNED = 200;

type MutableBucket = {
  identifier: string;
  success: number;
  failure: number;
  lastSeen: Date;
};

function upsertBucket(
  map: Map<string, MutableBucket>,
  identifier: string,
  ts: Date,
): MutableBucket {
  let b = map.get(identifier);
  if (!b) {
    b = { identifier, success: 0, failure: 0, lastSeen: ts };
    map.set(identifier, b);
  } else if (ts > b.lastSeen) {
    b.lastSeen = ts;
  }
  return b;
}

function bucketsToArray(map: Map<string, MutableBucket>): LoginActivityBucket[] {
  return Array.from(map.values())
    .map((b) => ({
      identifier: b.identifier,
      success: b.success,
      failure: b.failure,
      lastSeen: b.lastSeen.toISOString(),
    }))
    .sort((a, b) => b.failure - a.failure || b.success - a.success);
}

/**
 * Pull the attempted email out of an audit row's `after` blob when
 * present. Login-failure rows record `{ attemptedEmail }`; success
 * rows store the User as the entity, so we fall back to the actor's
 * email for those.
 */
function extractAttemptedEmail(row: {
  action: string;
  after: unknown;
  actor: { email: string } | null;
}): string | null {
  if (row.after && typeof row.after === 'object') {
    const v = (row.after as Record<string, unknown>).attemptedEmail;
    if (typeof v === 'string' && v.length > 0) return v.toLowerCase();
  }
  if (row.action === 'auth.login.success' && row.actor?.email) {
    return row.actor.email.toLowerCase();
  }
  return null;
}

export type LoginActivityBucket = {
  identifier: string;
  success: number;
  failure: number;
  lastSeen: string;
};

export type LoginActivityRow = {
  id: string;
  action: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  actorId: string | null;
  actor: { id: string; name: string; email: string } | null;
  attemptedEmail: string | null;
};

export type LockoutEntry = {
  identifier: string;
  failures: number;
  ttlSeconds: number | null;
  locked: boolean;
};

export type ThrottleBlockEntry = {
  throttler: string;
  tracker: string;
  blockedUntil: string | null;
  remainingMs: number;
};

export type EgressBlockRow = {
  id: string;
  createdAt: string;
  userAgent: string | null;
  url: string | null;
  hostname: string | null;
  resolvedIps: string[];
  reason: string | null;
  matchedCidr: string | null;
};

export type ActiveSessionRow = {
  id: string;
  ip: string;
  userAgent: string;
  mfaPending: boolean;
  createdAt: string;
  expiresAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    mfaEnabled: boolean;
    mfaEnrolled: boolean;
    isActive: boolean;
  };
};
