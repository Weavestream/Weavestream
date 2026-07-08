// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerOptions } from '@nestjs/throttler';
import { AUTH_THROTTLE_KEY } from '../../common/public.decorator.js';

// Stateless metadata reader; safe to share across requests.
const reflector = new Reflector();

// Matches LoginDto's @MaxLength(320) so an oversized body can't grow
// unbounded tracker keys before validation rejects it.
const MAX_EMAIL_LENGTH = 320;

/**
 * Tracker for the `auth` throttler: buckets login attempts per
 * (IP, email) pair, so an office behind one NAT egress IP doesn't
 * share a single bucket while any one (ip, email) stays capped.
 *
 * Guards run before the ValidationPipe, so `req.body` is parsed but
 * unvalidated here — the email is only used when it is a string, and
 * is normalized (trim/lowercase, mirroring LockoutService's keying)
 * so casing variants can't fan out into separate buckets. Requests
 * without a usable email all share the plain per-IP bucket; they are
 * throttled, not exempt.
 *
 * Loosening the key from per-IP to per-(IP, email) is deliberate:
 * single-IP password spraying across many emails is still stopped by
 * LockoutService's per-IP failure counter and the `global` per-IP
 * throttler.
 */
export function authThrottleTracker(req: Record<string, any>): string {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  const rawEmail: unknown = req.body?.email;
  const email =
    typeof rawEmail === 'string'
      ? rawEmail.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH)
      : '';
  return email ? `ip:${ip}:email:${email}` : `ip:${ip}`;
}

/**
 * The `auth` throttler is registered globally but applies only to
 * routes marked with `@AuthThrottle()` — everything else skips it.
 */
export function authThrottleSkipIf(context: ExecutionContext): boolean {
  return !reflector.getAllAndOverride<boolean>(AUTH_THROTTLE_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
}

/**
 * Named throttler entry for the ThrottlerModule config. `limit` comes
 * from `AUTH_RATE_LIMIT_PER_MIN` in production wiring; tests pass a
 * literal to assert the enforced limit follows the value.
 */
export function authThrottler(limit: number): ThrottlerOptions {
  return {
    name: 'auth',
    ttl: 60_000,
    limit,
    skipIf: authThrottleSkipIf,
    getTracker: authThrottleTracker,
  };
}
