import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { UiTheme, UiAccent } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { MfaService } from './mfa.service.js';
import { LockoutService } from './lockout.service.js';
import { EnvService } from '../config/env.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { SetupTokenService } from '../users/setup-token.service.js';
import { themeFromDb, accentFromDb } from './ui-preferences.mapping.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

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
    private readonly lockout: LockoutService,
    private readonly env: EnvService,
    private readonly audit: AuditLogService,
    private readonly setupTokens: SetupTokenService,
  ) {}

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
  ): Promise<void> {
    if (await this.lockout.isLocked(ip, user.email)) {
      throw new HttpException(
        'Too many failed attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const row = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!row?.mfaSecretEncrypted) {
      throw new BadRequestException('MFA not enrolled');
    }

    const secret = this.mfa.decryptSecret(row.mfaSecretEncrypted);
    const ok = this.mfa.verify(token, secret);
    if (!ok) {
      await this.lockout.recordFailure(ip, user.email);
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

    await this.lockout.clear(ip, user.email);

    const firstTime = row.mfaEnforcementCompletedAt === null;
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
      action: firstTime ? 'auth.mfa.enroll.complete' : 'auth.mfa.verify.success',
      entityType: 'User',
      entityId: user.id,
      ip,
      userAgent,
      before: null,
      after: null,
    });
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

  async refresh(
    refreshToken: string,
    ip: string,
    userAgent: string,
  ): Promise<{ accessToken: string; userId: string; sessionId: string } | null> {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.isActive) {
      return null;
    }
    const accessToken = await this.tokens.issueAccessToken({
      sub: session.userId,
      sid: session.id,
      role: session.user.role,
    });
    await this.audit.log({
      actorId: session.userId,
      action: 'auth.refresh',
      entityType: 'Session',
      entityId: session.id,
      ip,
      userAgent,
      before: null,
      after: null,
    });
    return { accessToken, userId: session.userId, sessionId: session.id };
  }
}
