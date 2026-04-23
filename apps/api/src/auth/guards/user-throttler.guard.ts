// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuthedUser } from '../../common/current-user.decorator.js';

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
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
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
}
