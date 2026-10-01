import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthedUser } from '../../common/current-user.decorator.js';
import { INTERACTIVE_ONLY_KEY } from '../interactive-only.decorator.js';
import { VAULT_REVEAL_KEY } from '../vault-reveal.decorator.js';

/**
 * Keeps API-key principals out of the surfaces that exist to manage the
 * *interactive* identity behind them.
 *
 * Without this, a leaked key is an escalation rather than a contained loss: it
 * could rotate the owner's password, re-enroll MFA onto an attacker's
 * authenticator, enumerate and revoke the owner's browser sessions, or mint
 * further keys for itself. Each of those turns "someone has a token I can
 * revoke" into "someone owns the account".
 *
 * Two layers. {@link InteractiveOnly} on the handler is primary and cannot
 * drift. The prefix denylist below is a backstop for the `/auth` and `/me`
 * trees — note it is **fail-open** by nature: a new account-management route
 * outside those trees is admitted unless it carries the decorator, which is
 * precisely why the decorator exists and should be preferred.
 *
 * The denylist is deliberately a **prefix list on the auth surface**,
 * not a scope check, because it must hold for every key regardless of how its
 * scopes were configured — including the default inherit-everything key a
 * SUPER_ADMIN mints for themselves. Business routes are unaffected; this guard
 * only ever says no to account-management paths.
 *
 * Runs after `AuthGuard` (which establishes `req.user`) and keys solely off the
 * server-derived principal, never off a client-supplied header (CLAUDE.md §1).
 */
const DENIED_PREFIXES = [
  // No trailing slash: `normalizePath` strips one, so '/auth/' would miss a
  // request to the bare '/auth' path and silently admit any handler later
  // mounted there.
  '/auth',                // login, logout, refresh, MFA enroll/verify, step-up
  '/me/sessions',         // list and revoke the owner's browser sessions
  '/me/mfa',              // backup-code regeneration
  '/me/change-password',  // the real route — MeController has no '/me/password'
  '/me/api-keys',         // a key must not mint or revoke keys; only a human may
] as const;

/**
 * Paths a token *is* allowed on despite matching a denied prefix. `/auth/me`
 * is read-only identity introspection ("who am I, what can I do"), which is
 * how a client discovers its own authority — useful, and it grants nothing.
 */
const ALLOWED_EXACT = new Set(['/auth/me']);

const DENIED_MESSAGE =
  'API keys cannot be used on account-management endpoints. Sign in interactively.';

/**
 * Reduce a raw request path to the stable route shape the lists above are
 * written against.
 *
 * The app mounts every route under `setGlobalPrefix('api')` with URI
 * versioning, so `req.path` arrives as `/api/v1/me/api-keys`. Matching the
 * denylist against the raw path would silently never fire — the guard would
 * appear installed and protect nothing.
 *
 * Also lowercases and collapses duplicate slashes: Express treats `//me//mfa`
 * and `/ME/MFA` as the same route, so a denylist that does not would be
 * trivially bypassable.
 */
function normalizePath(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/^\/api(?=\/|$)/, '')
    .replace(/^\/v\d+(?=\/|$)/, '')
    .replace(/\/+$/, '') || '/';
}

@Injectable()
export class ApiKeySurfaceGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>();
    if (!req.user?.apiKeyId) return true;

    // Primary check: the route declares its own requirement, so it cannot
    // drift away from a list maintained elsewhere.
    const interactiveOnly = this.reflector.getAllAndOverride<boolean>(
      INTERACTIVE_ONLY_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (interactiveOnly) throw new ForbiddenException(DENIED_MESSAGE);

    // Credential reveal: denied unless this specific key opted in at mint.
    // Default-deny because a key leaked from CI or a stray .env would
    // otherwise drain the vault this product exists to protect.
    const vaultReveal = this.reflector.getAllAndOverride<boolean>(
      VAULT_REVEAL_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (vaultReveal && !req.user.apiKeyAllowPasswordReveal) {
      throw new ForbiddenException(
        'This API key is not permitted to reveal stored credentials.',
      );
    }

    const path = normalizePath(req.path);
    if (ALLOWED_EXACT.has(path)) return true;

    if (DENIED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      throw new ForbiddenException(DENIED_MESSAGE);
    }
    return true;
  }
}
