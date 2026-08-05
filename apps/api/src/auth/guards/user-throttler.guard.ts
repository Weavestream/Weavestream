// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuthedUser } from '../../common/current-user.decorator.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../audit/audit-actions.js';
import { RedisService } from '../../redis/redis.service.js';
import { claimOnce } from '../../common/claim-once.js';
import { ipOf, userAgentOf } from '../../common/request-meta.js';

/**
 * `ThrottlerLimitDetail` does not carry the throttler's name, so
 * `handleRequest` stashes it on the request under this symbol for
 * `throwThrottlingException` to read — the audit payload should say
 * WHICH limiter rejected (`auth` vs `global`).
 */
const THROTTLER_NAME_PROP = Symbol('wsThrottlerName');

/**
 * Per-user (falling back to per-IP) rate-limit tracker.
 *
 * Wired in after {@link AuthGuard} in `APP_GUARD` order, so `req.user`
 * has already been resolved by the time `getTracker` runs for
 * authenticated routes. For anonymous traffic (`/login`, `/signup`,
 * public probes, health) we fall back to the client IP — which is
 * the real client once {@link main.ts} has `trust proxy` set and the
 * web SSR layer forwards `x-forwarded-for`.
 *
 * The previous behaviour was "IP only, bucketed against Express's
 * raw socket peer". In Docker that meant every authenticated SSR
 * call from every operator shared a single global bucket keyed on
 * the web container's internal bridge address — a single user
 * refreshing a company page could exhaust the 100-req/min quota in
 * one action. Keying on user id gives each signed-in operator their
 * own isolated budget, so concurrent users don't starve each other.
 *
 * We intentionally keep the `global` throttler name; only the
 * identity it hashes into changes. That way the Redis key space
 * stays layer-compatible with existing deployments — old keys just
 * age out of their 60s TTL naturally.
 *
 * Rejections additionally emit a `security.ratelimit.blocked` audit
 * row (coalesced to one per limiter+key per block window) that feeds
 * the "IP blocked or rate limited" security alert. This is pure
 * observation: the 429, its message, and the Retry-After header are
 * byte-identical to the stock guard — `handleRequest` sets the header
 * before `throwThrottlingException` runs, and our override ends by
 * delegating to `super`.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(UserThrottlerGuard.name);

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly audit: AuditLogService,
    private readonly redis: RedisService,
  ) {
    super(options, storageService, reflector);
  }

  protected override async getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const expressReq = req as unknown as Request & { user?: AuthedUser };
    if (expressReq.user?.id) return `user:${expressReq.user.id}`;

    // Prefer the forwarded chain's leftmost entry. Express already
    // parses this into `req.ip` when `trust proxy` is configured;
    // fall back to the raw socket address if both are missing.
    const ip =
      expressReq.ip ??
      (expressReq.socket?.remoteAddress as string | undefined) ??
      'unknown';
    return `ip:${ip}`;
  }

  protected override async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const { req } = this.getRequestResponse(requestProps.context);
    (req as Record<PropertyKey, unknown>)[THROTTLER_NAME_PROP] =
      requestProps.throttler.name ?? 'global';
    return super.handleRequest(requestProps);
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    this.recordRejection(context, detail);
    return super.throwThrottlingException(context, detail);
  }

  /**
   * Detached, best-effort audit of one throttler rejection. Never
   * throws into the 429 path; adds zero latency (the async work is
   * fired and forgotten).
   *
   * Unit care — the storage returns MILLISECONDS: this repo's
   * `RedisThrottlerStorage` hands back raw `PTTL` / `blockDuration`
   * values (the in-memory storage used in tests returns seconds,
   * which would mask a unit bug — the spec asserts the actual TTL).
   * Everything persisted is converted to whole seconds.
   *
   * Privacy — the coalescing key uses `detail.key`, the stock
   * generated hash. Never the raw tracker: for the auth limiter the
   * tracker embeds the attempted email, and the stock pipeline only
   * ever stores its hash. The audit payload's `attemptedEmail` is
   * read from the request body (bounded), never parsed out of the
   * tracker.
   */
  private recordRejection(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): void {
    try {
      const req = context
        .switchToHttp()
        .getRequest<Request & { user?: AuthedUser }>();
      const limiterRaw = (req as unknown as Record<PropertyKey, unknown>)[
        THROTTLER_NAME_PROP
      ];
      const limiter = typeof limiterRaw === 'string' ? limiterRaw : 'global';

      const remainingMs = detail.timeToBlockExpire || detail.timeToExpire;
      const retryAfterSec = Math.max(1, Math.ceil(remainingMs / 1000));
      const windowSec = Math.max(1, Math.ceil(detail.ttl / 1000));
      const route = ((req.path ?? req.url ?? '').split('?')[0] ?? '').slice(0, 300);
      const method = req.method;
      const ip = ipOf(req);
      const userAgent = userAgentOf(req);
      const actorId = req.user?.id ?? null;
      const attemptedEmail =
        limiter === 'auth' ? extractAttemptedEmail(req.body) : undefined;

      const coalesceKey = `secalert:throttle:${limiter}:${detail.key}`;
      void (async () => {
        // Dedup for exactly the Redis block window: one audit row (and
        // one alert email) per limiter+key per block, no matter how
        // hard the blocked client hammers.
        if (!(await claimOnce(this.redis.client, coalesceKey, retryAfterSec))) {
          return;
        }
        await this.audit.log({
          actorId,
          action: AUDIT_ACTIONS.security.ratelimitBlocked,
          entityType: 'RateLimit',
          entityId: null,
          ip,
          userAgent,
          before: null,
          after: {
            limiter,
            limit: detail.limit,
            windowSec,
            route,
            method,
            retryAfterSec,
            ...(attemptedEmail ? { attemptedEmail } : {}),
          },
        });
      })().catch((err) =>
        this.logger.warn(
          `ratelimit audit failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    } catch (err) {
      // Observation must never break the rejection itself.
      this.logger.warn(
        `ratelimit rejection observation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Mirror of `authThrottleTracker`'s email normalization (trim,
 * lowercase, cap at the 320-char RFC bound) — for the audit payload
 * only, sourced from the body the tracker itself reads.
 */
function extractAttemptedEmail(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const email = (body as Record<string, unknown>).email;
  if (typeof email !== 'string') return undefined;
  const cleaned = email.trim().toLowerCase().slice(0, 320);
  return cleaned.length > 0 ? cleaned : undefined;
}
