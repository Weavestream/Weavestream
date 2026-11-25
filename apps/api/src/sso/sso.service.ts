import { createHash } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { z } from 'zod';
import type { SsoConfig, SsoErrorCode } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EnvService } from '../config/env.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { AuthService, type LoginResult } from '../auth/auth.service.js';
import { StepUpService } from '../auth/step-up/step-up.service.js';
import { SSO_FLOW_MAX_AGE_MS } from '../auth/cookies.js';
import type { RequestMeta } from '../common/request-meta.js';
import { IdTokenError, type VerifiedIdToken } from './id-token.js';
import { SsoOidcService, SsoProviderError } from './sso-oidc.service.js';
import { SsoConfigService } from './sso-config.service.js';
import { constantTimeEqual, newAuthRequestSecrets } from './sso-pkce.js';

/** A step-up re-authentication must have happened this recently. */
export const STEP_UP_MAX_AUTH_AGE_SEC = 120;
/** Tolerated clock skew when the IdP's `auth_time` is slightly in the future. */
const AUTH_TIME_SKEW_SEC = 60;

/**
 * Fixed strings inside the signed flow payload, verified on read. A signed
 * cookie from one flow (or any other signed value of ours) cannot be replayed
 * into the other.
 */
const FLOW_PURPOSE = {
  login: 'weavestream.sso.login.v1',
  stepup: 'weavestream.sso.stepup.v1',
  link: 'weavestream.sso.link.v1',
} as const;

const flowSchema = z.object({
  /** fixed purpose string, must match `p` */ k: z.string(),
  /** state */ s: z.string().min(1),
  /** nonce */ n: z.string().min(1),
  /** PKCE verifier */ v: z.string().min(1),
  /** purpose */ p: z.enum(['login', 'stepup', 'link']),
  /** issued-at, ms */ t: z.number(),
  /** step-up and link: the user and session the flow is bound to */ u: z.string().optional(),
  sid: z.string().optional(),
});
type Flow = z.infer<typeof flowSchema>;

export type SsoFailureReason =
  | 'flow_cookie_missing'
  | 'flow_cookie_expired'
  | 'state_mismatch'
  | 'idp_error'
  | 'idp_denied'
  | 'missing_code'
  | 'discovery_failed'
  | 'token_exchange_failed'
  | 'invalid_token'
  | 'token_expired'
  | 'nonce_mismatch'
  | 'tenant_mismatch'
  | 'no_email'
  | 'email_unverified'
  | 'privileged_account'
  | 'missing_oid'
  | 'no_account'
  | 'link_by_email_disabled'
  | 'inactive_user'
  | 'pending_invite'
  | 'already_linked'
  | 'stepup_stale_auth'
  | 'stepup_identity_mismatch'
  | 'stepup_session_invalid'
  | 'link_session_invalid'
  | 'link_stepup_lapsed'
  | 'identity_taken'
  | 'already_linked_user'
  | 'internal_error';

export type SsoCallbackOutcome =
  | {
      ok: true;
      kind: 'login';
      login: LoginResult;
      /** Setup wins over challenge, as in the password flow. */
      mfaSetupRequired: boolean;
      mfaChallengeRequired: boolean;
    }
  | { ok: true; kind: 'stepup' }
  | { ok: true; kind: 'link' }
  // `purpose` is present only for a self-service link, whose errors go back to /me.
  | { ok: false; code: SsoErrorCode; purpose?: 'link' };

export interface SsoCallbackInput {
  /** Raw signed flow cookie value (undefined when absent or unsigned). */
  flowCookie: unknown;
  code: unknown;
  state: unknown;
  /** The provider's `error` query parameter, if it sent one. */
  idpError: unknown;
  meta: RequestMeta;
  /** Request id for correlating the server log line; never client data. */
  requestId?: string;
}

/** Map each internal reason to the short code the browser is sent back with. */
const CODE_FOR: Record<SsoFailureReason, SsoErrorCode> = {
  flow_cookie_missing: 'expired',
  flow_cookie_expired: 'expired',
  state_mismatch: 'failed',
  idp_error: 'failed',
  idp_denied: 'not_allowed',
  missing_code: 'failed',
  discovery_failed: 'failed',
  token_exchange_failed: 'failed',
  invalid_token: 'failed',
  token_expired: 'failed',
  nonce_mismatch: 'failed',
  tenant_mismatch: 'not_allowed',
  no_email: 'no_account',
  email_unverified: 'no_account',
  privileged_account: 'not_allowed',
  missing_oid: 'failed',
  no_account: 'no_account',
  link_by_email_disabled: 'no_account',
  inactive_user: 'not_allowed',
  pending_invite: 'not_allowed',
  already_linked: 'not_allowed',
  stepup_stale_auth: 'failed',
  stepup_identity_mismatch: 'not_allowed',
  stepup_session_invalid: 'failed',
  link_session_invalid: 'failed',
  link_stepup_lapsed: 'failed',
  identity_taken: 'not_allowed',
  already_linked_user: 'not_allowed',
  internal_error: 'failed',
};

/** Internal control-flow carrier; never leaves this file. */
class SsoRefusal extends Error {
  constructor(
    readonly reason: SsoFailureReason,
    readonly actorId: string | null = null,
  ) {
    super(reason);
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+$/;

const ENTRA_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.microsoftonline.us',
  'login.partner.microsoftonline.cn',
  'sts.windows.net',
]);

/** SHA-256 prefix: enough to correlate audit rows, useless to recover the value. */
const hashPrefix = (v: string): string =>
  createHash('sha256').update(v).digest('hex').slice(0, 12);

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly oidc: SsoOidcService,
    private readonly ssoConfig: SsoConfigService,
    private readonly auth: AuthService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditLogService,
  ) {}

  async isEnabled(): Promise<boolean> {
    return this.oidc.enabled();
  }

  /** Public, secret-free configuration for the login page. */
  async config(): Promise<SsoConfig> {
    const cfg = await this.ssoConfig.get();
    return {
      enabled: cfg.enabled,
      providerName: cfg.providerName,
      localLoginEnabled: cfg.localLoginEnabled,
    };
  }

  /**
   * Start a flow: returns the IdP URL and the value for the signed flow
   * cookie. `stepUp` binds the flow to the user and session being confirmed
   * (both come from the authenticated request, never from the client).
   */
  async begin(
    stepUp?: { userId: string; sessionId: string },
  ): Promise<{ url: string; flowCookie: string }> {
    return this.startFlow(stepUp ? 'stepup' : 'login', stepUp);
  }

  /**
   * Start a self-service link: a signed-in user binds a provider account to
   * their own user. Bound to the user and session from the authenticated
   * request; the provider is asked to let the person pick the account.
   */
  async beginLink(who: {
    userId: string;
    sessionId: string;
  }): Promise<{ url: string; flowCookie: string }> {
    return this.startFlow('link', who);
  }

  private async startFlow(
    purpose: Flow['p'],
    who?: { userId: string; sessionId: string },
  ): Promise<{ url: string; flowCookie: string }> {
    const secrets = newAuthRequestSecrets();
    const url = await this.oidc.authorizationUrl({
      state: secrets.state,
      nonce: secrets.nonce,
      challenge: secrets.challenge,
      reauthenticate: purpose === 'stepup',
      selectAccount: purpose === 'link',
    });
    const flow: Flow = {
      s: secrets.state,
      n: secrets.nonce,
      v: secrets.verifier,
      p: purpose,
      k: FLOW_PURPOSE[purpose],
      t: Date.now(),
      ...(who ? { u: who.userId, sid: who.sessionId } : {}),
    };
    return { url, flowCookie: JSON.stringify(flow) };
  }

  /** Complete either flow. Never throws: every failure is a code to redirect with. */
  async complete(input: SsoCallbackInput): Promise<SsoCallbackOutcome> {
    let purpose: Flow['p'] = 'login';
    let claims: VerifiedIdToken | undefined;
    try {
      const flow = this.readFlow(input.flowCookie);
      purpose = flow.p;

      if (typeof input.idpError === 'string' && input.idpError.length > 0) {
        // Entra answers `access_denied` for a user who is not assigned to the
        // application or who declined consent; surface that as "not allowed".
        throw new SsoRefusal(input.idpError === 'access_denied' ? 'idp_denied' : 'idp_error');
      }
      if (typeof input.state !== 'string' || !constantTimeEqual(input.state, flow.s)) {
        throw new SsoRefusal('state_mismatch');
      }
      if (typeof input.code !== 'string' || input.code.length === 0 || input.code.length > 4096) {
        throw new SsoRefusal('missing_code');
      }

      claims = await this.exchangeAndVerify(input.code, flow);

      if (flow.p === 'stepup') return await this.completeStepUp(flow, claims, input.meta);
      if (flow.p === 'link') return await this.completeLink(flow, claims, input.meta);
      return await this.completeLogin(claims, input.meta);
    } catch (err) {
      return this.fail(err, purpose, input, claims);
    }
  }

  // ── login ───────────────────────────────────────────────────────────

  private async completeLogin(
    claims: VerifiedIdToken,
    meta: RequestMeta,
  ): Promise<SsoCallbackOutcome> {
    const { user, identityId } = await this.resolveUser(claims, meta);

    // Diagnostics (no secrets): did the provider send `amr` at all, and did we
    // accept it as MFA. Tells an admin whether a missing `mfa` is the
    // provider's doing or ours.
    const amrPresent = claims.amr.length > 0;
    const cfg = await this.ssoConfig.get();
    // assumeIdpMfa is already ANDed with trustIdpMfa by the config service, so
    // it can never grant MFA on its own.
    const idpMfa = cfg.trustIdpMfa && (cfg.assumeIdpMfa || claims.amr.includes('mfa'));
    const { result, sessionId, mfaChallengeRequired, mfaSetupRequired } =
      await this.auth.issueSession(user, {
        ip: meta.ip,
        userAgent: meta.userAgent,
        authMethod: 'sso',
        idpMfa,
      });

    // The session now exists. If recording it fails, do not leave a live
    // session behind that the user was told did not happen: revoke it.
    try {
      await this.prisma.userIdentity.update({
        where: { id: identityId },
        data: { lastLoginAt: new Date(), email: this.emailOf(claims) ?? null },
      });
      await this.audit.log({
        actorId: user.id,
        action: AUDIT_ACTIONS.auth.ssoLoginSuccess,
        entityType: 'Session',
        entityId: sessionId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          issuerHost: (await this.oidc.issuerHost()),
          idpMfa,
          amrPresent,
          idpMfaAsserted: idpMfa,
          assumeIdpMfa: cfg.assumeIdpMfa,
          mfaPending: mfaChallengeRequired,
          mfaSetupRequired,
        },
      });
      this.logger.log(
        `SSO login succeeded (session ${sessionId}): amrPresent=${amrPresent} idpMfaAsserted=${idpMfa} assumeIdpMfa=${cfg.assumeIdpMfa} mfaPending=${mfaChallengeRequired} mfaSetupRequired=${mfaSetupRequired}`,
      );
    } catch (err) {
      try {
        await this.prisma.session.updateMany({
          where: { id: sessionId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } catch (revokeErr) {
        this.logger.error(
          `Failed to revoke SSO session after a post-login error (${revokeErr instanceof Error ? revokeErr.name : 'unknown'})`,
        );
      }
      throw err;
    }

    return { ok: true, kind: 'login', login: result, mfaSetupRequired, mfaChallengeRequired };
  }

  /**
   * Find the Weavestream user for a verified token. A user is matched by the
   * `(issuer, subject)` link, never by email once linked. The first sign-in
   * links by email (only when allowed), or provisions (only when allowed).
   */
  private async resolveUser(
    claims: VerifiedIdToken,
    meta: RequestMeta,
  ): Promise<{ user: User; identityId: string }> {
    const issuer = await this.oidc.issuer();
    const subject = await this.subjectOf(claims);

    const linked = await this.prisma.userIdentity.findUnique({
      where: { issuer_subject: { issuer, subject } },
      include: { user: true },
    });
    if (linked) {
      if (!linked.user.isActive) throw new SsoRefusal('inactive_user', linked.user.id);
      return { user: linked.user, identityId: linked.id };
    }

    const email = this.emailOf(claims);
    if (!email) throw new SsoRefusal('no_email');

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      if (!(await this.ssoConfig.get()).linkByEmail) {
        throw new SsoRefusal('link_by_email_disabled', existing.id);
      }
      // An email claim proves nothing unless the provider says it verified
      // it. An absent claim is NOT verification.
      if (!claims.emailVerified && !claims.emailDomainOwnerVerified) {
        throw new SsoRefusal('email_unverified', existing.id);
      }
      if (!existing.isActive) throw new SsoRefusal('inactive_user', existing.id);
      // Never auto-link a privileged account: a matching email must not be
      // enough to reach SUPER_ADMIN or platform-admin authority. Link those
      // by hand (or sign in with the password and an administrator).
      if (existing.role === 'SUPER_ADMIN' || existing.platformCapabilities.length > 0) {
        throw new SsoRefusal('privileged_account', existing.id);
      }
      // An invite that was never accepted has no password and no owner yet;
      // an email match is not proof of who is holding it.
      if (existing.passwordHash === null) throw new SsoRefusal('pending_invite', existing.id);
      // Already tied to a different account at this issuer: do not silently
      // add a second one (a recycled address must not inherit the access).
      const other = await this.prisma.userIdentity.findFirst({
        where: { userId: existing.id, issuer },
        select: { id: true },
      });
      if (other) throw new SsoRefusal('already_linked', existing.id);

      const identity = await this.prisma.userIdentity.create({
        data: { userId: existing.id, issuer, subject, email },
      });
      await this.audit.log({
        actorId: existing.id,
        action: AUDIT_ACTIONS.auth.ssoLink,
        entityType: 'User',
        entityId: existing.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: { via: 'email', issuerHost: (await this.oidc.issuerHost()), identityId: identity.id },
      });
      return { user: existing, identityId: identity.id };
    }

    if (!(await this.ssoConfig.get()).autoProvision) throw new SsoRefusal('no_account');

    // New OPERATOR with no access and no memberships: they land on the
    // "Access pending" screen until an administrator grants some.
    const created = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email,
          name: claims.name ?? email.split('@')[0] ?? email,
          role: 'OPERATOR',
          globalAccess: 'NONE',
          platformCapabilities: [],
          passwordHash: null,
          mfaEnabled: false,
          mfaEnforcementCompletedAt: null,
        },
      });
      const identity = await tx.userIdentity.create({
        data: { userId: u.id, issuer, subject, email },
      });
      return { user: u, identityId: identity.id };
    });
    await this.audit.log({
      actorId: created.user.id,
      action: AUDIT_ACTIONS.auth.ssoProvision,
      entityType: 'User',
      entityId: created.user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        issuerHost: (await this.oidc.issuerHost()),
        identityId: created.identityId,
        role: 'OPERATOR',
        globalAccess: 'NONE',
      },
    });
    return created;
  }

  // ── self-service link ───────────────────────────────────────────────

  /**
   * Bind the verified `(issuer, subject)` to the user the flow was started
   * for. It never reads the email claim, creates no session and does not
   * touch the current one. Linking is explicit and the person is already
   * signed in and step-up confirmed, which is why it is allowed for any role,
   * SUPER_ADMIN included (auto-link by email is not).
   */
  private async completeLink(
    flow: Flow,
    claims: VerifiedIdToken,
    meta: RequestMeta,
  ): Promise<SsoCallbackOutcome> {
    if (!flow.u || !flow.sid) throw new SsoRefusal('link_session_invalid');
    const userId = flow.u;

    // The session that started the flow must still be live and still belong
    // to that user (not revoked or expired, not MFA-pending, user active).
    const [session, user] = await Promise.all([
      this.prisma.session.findUnique({ where: { id: flow.sid } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }),
    ]);
    if (
      !session ||
      session.userId !== userId ||
      session.revokedAt ||
      session.expiresAt < new Date() ||
      session.mfaPending ||
      !user?.isActive
    ) {
      throw new SsoRefusal('link_session_invalid', userId);
    }
    // The step-up that allowed the start must not have lapsed during the
    // round trip to the provider.
    if (!(await this.stepUp.isVerified(session.id))) {
      throw new SsoRefusal('link_stepup_lapsed', userId);
    }

    const issuer = await this.oidc.issuer();
    const subject = await this.subjectOf(claims);

    const taken = await this.prisma.userIdentity.findUnique({
      where: { issuer_subject: { issuer, subject } },
      select: { id: true, userId: true },
    });
    if (taken) {
      throw new SsoRefusal(taken.userId === userId ? 'already_linked_user' : 'identity_taken', userId);
    }
    // One identity per issuer and user. Unlink first to change it.
    const mine = await this.prisma.userIdentity.findFirst({
      where: { userId, issuer },
      select: { id: true },
    });
    if (mine) throw new SsoRefusal('already_linked_user', userId);

    const identity = await this.prisma.userIdentity.create({
      data: { userId, issuer, subject, email: this.emailOf(claims) ?? null },
    });
    await this.audit.log({
      actorId: userId,
      action: AUDIT_ACTIONS.auth.ssoLink,
      entityType: 'User',
      entityId: userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        reason: 'self_service',
        via: 'self_service',
        sessionId: session.id,
        issuerHost: (await this.oidc.issuerHost()),
        identityId: identity.id,
        ...(await this.identityHashes(claims)),
      },
    });
    return { ok: true, kind: 'link' };
  }

  /** Whether the signed-in user has a provider account linked. */
  async linkStatus(userId: string): Promise<{ enabled: boolean; linked: boolean; providerName: string }> {
    const cfg = await this.ssoConfig.get();
    const providerName = cfg.providerName;
    if (!cfg.enabled) return { enabled: false, linked: false, providerName };
    const identity = await this.prisma.userIdentity.findFirst({
      where: { userId, issuer: await this.oidc.issuer() },
      select: { id: true },
    });
    return { enabled: true, linked: !!identity, providerName };
  }

  /**
   * Remove the signed-in user's link. Refused when it would leave the
   * account with no way in: no password at all, or password sign-in is off
   * for their role (`SSO_LOCAL_LOGIN=false` and not SUPER_ADMIN).
   */
  async unlink(userId: string, meta: RequestMeta): Promise<{ ok: true }> {
    const issuer = await this.oidc.issuer();
    const [identity, user] = await Promise.all([
      this.prisma.userIdentity.findFirst({ where: { userId, issuer }, select: { id: true } }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true, role: true },
      }),
    ]);
    if (!user) throw new NotFoundException();
    if (!identity) throw new NotFoundException('No single sign-on account is linked');

    const noPassword = user.passwordHash === null;
    const localOff = (await this.ssoConfig.get()).localLoginEnabled === false && user.role !== 'SUPER_ADMIN';
    if (noPassword || localOff) {
      await this.audit.log({
        actorId: userId,
        action: AUDIT_ACTIONS.auth.ssoUnlink,
        entityType: 'User',
        entityId: userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          refused: true,
          reason: noPassword ? 'no_password' : 'local_login_disabled',
          issuerHost: (await this.oidc.issuerHost()),
        },
      });
      throw new ConflictException(
        'Unlinking would leave this account with no way to sign in. Set a password first.',
      );
    }

    await this.prisma.userIdentity.delete({ where: { id: identity.id } });
    await this.audit.log({
      actorId: userId,
      action: AUDIT_ACTIONS.auth.ssoUnlink,
      entityType: 'User',
      entityId: userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { issuerHost: (await this.oidc.issuerHost()), identityId: identity.id },
    });
    return { ok: true };
  }

  // ── step-up ─────────────────────────────────────────────────────────

  private async completeStepUp(
    flow: Flow,
    claims: VerifiedIdToken,
    meta: RequestMeta,
  ): Promise<SsoCallbackOutcome> {
    if (!flow.u || !flow.sid) throw new SsoRefusal('stepup_session_invalid');

    // A fresh authentication, not just a fresh token: `auth_time` is when the
    // user last typed their credentials at the provider.
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      claims.authTime === undefined ||
      nowSec - claims.authTime > STEP_UP_MAX_AUTH_AGE_SEC ||
      claims.authTime - nowSec > AUTH_TIME_SKEW_SEC
    ) {
      throw new SsoRefusal('stepup_stale_auth', flow.u);
    }

    // The account that just re-authenticated at the provider must be the one
    // whose session is being confirmed.
    const identity = await this.prisma.userIdentity.findUnique({
      where: { issuer_subject: { issuer: await this.oidc.issuer(), subject: await this.subjectOf(claims) } },
      select: { userId: true },
    });
    if (!identity || identity.userId !== flow.u) {
      throw new SsoRefusal('stepup_identity_mismatch', flow.u);
    }

    const [session, user] = await Promise.all([
      this.prisma.session.findUnique({ where: { id: flow.sid } }),
      this.prisma.user.findUnique({ where: { id: flow.u }, select: { isActive: true } }),
    ]);
    if (
      !session ||
      session.userId !== flow.u ||
      session.revokedAt ||
      session.expiresAt < new Date() ||
      session.authMethod !== 'sso' ||
      session.mfaPending ||
      !user?.isActive
    ) {
      throw new SsoRefusal('stepup_session_invalid', flow.u);
    }

    await this.stepUp.markVerified(session.id, 'sso');
    await this.audit.log({
      actorId: flow.u,
      action: AUDIT_ACTIONS.auth.ssoStepUp,
      entityType: 'Session',
      entityId: session.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { factor: 'sso', sessionId: session.id, issuerHost: (await this.oidc.issuerHost()) },
    });
    return { ok: true, kind: 'stepup' };
  }

  // ── shared ──────────────────────────────────────────────────────────

  private readFlow(raw: unknown): Flow {
    if (typeof raw !== 'string') throw new SsoRefusal('flow_cookie_missing');
    let parsed: Flow;
    try {
      parsed = flowSchema.parse(JSON.parse(raw));
    } catch {
      // Signed by us, so this is a stale format or a bug, not an attacker.
      throw new SsoRefusal('flow_cookie_missing');
    }
    if (parsed.k !== FLOW_PURPOSE[parsed.p]) throw new SsoRefusal('flow_cookie_missing');
    if (Date.now() - parsed.t > SSO_FLOW_MAX_AGE_MS) throw new SsoRefusal('flow_cookie_expired');
    return parsed;
  }

  private async exchangeAndVerify(code: string, flow: Flow): Promise<VerifiedIdToken> {
    let idToken: string;
    try {
      idToken = await this.oidc.exchangeCode(code, flow.v);
    } catch (err) {
      if (err instanceof SsoProviderError) throw new SsoRefusal(err.reason);
      throw new SsoRefusal('token_exchange_failed');
    }
    try {
      return await this.oidc.verifyIdToken(idToken, flow.n);
    } catch (err) {
      if (err instanceof SsoProviderError) throw new SsoRefusal(err.reason);
      if (err instanceof IdTokenError) {
        throw new SsoRefusal(
          err.failure === 'expired'
            ? 'token_expired'
            : err.failure === 'nonce_mismatch'
              ? 'nonce_mismatch'
              : err.failure === 'tenant_mismatch'
                ? 'tenant_mismatch'
                : 'invalid_token',
        );
      }
      throw new SsoRefusal('invalid_token');
    }
  }

  /**
   * The stable per-user identifier. For an Entra issuer it is `oid` and
   * nothing else (a token without one is refused), so the subject can never
   * flip between `oid` and `sub` for the same person. Other providers use `sub`.
   */
  async subjectOf(claims: VerifiedIdToken): Promise<string> {
    if (await this.isEntra()) {
      if (!claims.oid) throw new SsoRefusal('missing_oid');
      return claims.oid;
    }
    return claims.sub;
  }

  private async isEntra(): Promise<boolean> {
    return ENTRA_HOSTS.has((await this.oidc.issuerHost()).toLowerCase());
  }

  /**
   * The address used to find an existing user: the `email` claim only,
   * lowercased. `preferred_username` (an Entra UPN, mutable and not a
   * verified mailbox) is deliberately NOT used.
   */
  private emailOf(claims: VerifiedIdToken): string | undefined {
    const email = claims.email?.trim().toLowerCase();
    return email && email.length <= 320 && EMAIL.test(email) ? email : undefined;
  }

  private async fail(
    err: unknown,
    purpose: Flow['p'],
    input: SsoCallbackInput,
    claims?: VerifiedIdToken,
  ): Promise<SsoCallbackOutcome> {
    let reason: SsoFailureReason;
    let actorId: string | null = null;
    if (err instanceof SsoRefusal) {
      reason = err.reason;
      actorId = err.actorId;
    } else {
      reason = 'internal_error';
      // Name only: an error message could carry request or database detail.
      this.logger.error(
        `SSO ${purpose} errored (${err instanceof Error ? err.name : 'unknown'}) req=${input.requestId ?? '-'}`,
      );
    }
    this.logger.warn(`SSO ${purpose} refused: ${reason} req=${input.requestId ?? '-'}`);
    try {
      await this.audit.log({
        actorId,
        action: AUDIT_ACTIONS.auth.ssoLoginFailure,
        entityType: 'User',
        entityId: actorId,
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
        before: null,
        after: {
          reason,
          purpose,
          issuerHost: (await this.oidc.issuerHost()),
          ...(await this.identityHashes(claims)),
        },
      });
    } catch (auditErr) {
      this.logger.error(
        `Failed to audit SSO failure (${auditErr instanceof Error ? auditErr.name : 'unknown'}) req=${input.requestId ?? '-'}`,
      );
    }
    return purpose === 'link'
      ? { ok: false, code: CODE_FOR[reason], purpose: 'link' }
      : { ok: false, code: CODE_FOR[reason] };
  }

  /** Hash prefixes of the subject and email (when the token had them) for failure audit rows. */
  private async identityHashes(
    claims?: VerifiedIdToken,
  ): Promise<{ subjectHash?: string; emailHash?: string }> {
    if (!claims) return {};
    const out: { subjectHash?: string; emailHash?: string } = {};
    try {
      out.subjectHash = hashPrefix(await this.subjectOf(claims));
    } catch {
      // An Entra token with no oid has no subject to hash; the reason already says so.
    }
    const email = this.emailOf(claims);
    if (email) out.emailHash = hashPrefix(email);
    return out;
  }
}
