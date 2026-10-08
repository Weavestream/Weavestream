import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { ApiKey, Prisma } from '@prisma/client';
import type { CreateApiKeyInput } from '@weavestream/shared';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';
import { revokeApiKeysForUser } from './revoke-api-keys.js';

/**
 * Presented-token format: `ws_<keyId>_<secret>`.
 *
 * `keyId` is public and indexed — it selects exactly one row, so verification
 * never scans the table and never uses the secret as a lookup value. `secret`
 * is 32 bytes of CSPRNG output, base64url encoded, and is compared against a
 * stored SHA-256 digest in constant time.
 *
 * On the choice of SHA-256 over Argon2id (CLAUDE.md §2): the rule exists
 * because passwords are low-entropy and must survive offline cracking. This
 * secret is 256 bits of `randomBytes` with no structure to guess, so a fast
 * digest is preimage-safe, and it is verified on every single request where a
 * deliberately-slow KDF would add ~100ms of CPU per call. The slow-KDF rule
 * still applies to anything a human chooses.
 */
const PREFIX = 'ws';
const SECRET_BYTES = 32;
const KEY_ID_BYTES = 9;

/**
 * `keyId` is hex, not base64url, precisely because the token separator is `_`
 * and the base64url alphabet *contains* `_`. A base64url keyId would make the
 * token ambiguous to split. The secret stays base64url (denser, and it is only
 * ever taken as "everything after the second separator", so its alphabet is
 * irrelevant).
 */

/** Default lifetime when the caller does not specify one. Never "forever". */
export const DEFAULT_EXPIRY_DAYS = 365;

/** Coarsest useful resolution for `lastUsedAt`; keeps writes off the hot path. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface MintedApiKey {
  record: ApiKey;
  /**
   * The full token, returned exactly once at creation and never recoverable.
   * Permitted under the one-time-delivery carve-out in CLAUDE.md §2: it is
   * server-generated for this authorized request, never reflected from the
   * request body, never logged, and the mint itself is audited by id.
   */
  token: string;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

@Injectable()
export class ApiKeyService {

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Split a presented token into its public and secret halves. Returns null
   * for anything that is not well-formed, so callers never attempt a lookup
   * with attacker-shaped input.
   */
  parse(presented: string): { keyId: string; secret: string } | null {
    // Split on the first two separators only. The secret is base64url, whose
    // alphabet includes `_`, so a naive three-way split would reject roughly
    // half of all legitimately-minted tokens.
    const first = presented.indexOf('_');
    if (first < 0) return null;
    const second = presented.indexOf('_', first + 1);
    if (second < 0) return null;

    const prefix = presented.slice(0, first);
    const keyId = presented.slice(first + 1, second);
    const secret = presented.slice(second + 1);
    if (prefix !== PREFIX || !keyId || !secret) return null;
    // keyId is always hex; reject anything else before it reaches a query.
    // Exact length, not just charset: this value reaches an unauthenticated
    // indexed lookup, and an unbounded hex string would let a caller push
    // arbitrary bytes into that query.
    if (keyId.length !== KEY_ID_BYTES * 2) return null;
    if (!/^[0-9a-f]+$/.test(keyId)) return null;
    return { keyId, secret };
  }

  async mint(params: {
    userId: string;
    name: string;
    scopes?: string[];
    expiresInDays?: number | null;
    allowPasswordReveal?: boolean;
    allowWrite?: boolean;
    createdBy: string;
  }, client: Prisma.TransactionClient | PrismaService = this.prisma): Promise<MintedApiKey> {
    // The `scopes` column exists so a later change can narrow a key below its
    // owner's authority without a migration — but nothing consumes it yet.
    // Accepting a scope list we do not enforce would hand the caller a control
    // that silently does nothing, which is strictly worse than not offering
    // one: an operator would believe a key was restricted when it is not.
    // Reject until PermissionGuard honours it.
    if (params.scopes && params.scopes.length > 0) {
      throw new BadRequestException(
        'Scoped API keys are not supported yet; a key inherits its owner\'s permissions. Omit "scopes".',
      );
    }

    const keyId = randomBytes(KEY_ID_BYTES).toString('hex');
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const days =
      params.expiresInDays === null
        ? null
        : (params.expiresInDays ?? DEFAULT_EXPIRY_DAYS);
    const record = await client.apiKey.create({
      data: {
        userId: params.userId,
        keyId,
        tokenHash: sha256(secret).toString('hex'),
        name: params.name,
        scopes: params.scopes ?? [],
        allowPasswordReveal: params.allowPasswordReveal ?? false,
        allowWrite: params.allowWrite ?? false,
        expiresAt:
          days === null ? null : new Date(Date.now() + days * 86_400_000),
        createdBy: params.createdBy,
      },
    });
    return { record, token: `${PREFIX}_${keyId}_${secret}` };
  }

  /**
   * Resolve a presented token to its live key row, or null.
   *
   * Returns null — never throws, never distinguishes — for unknown, revoked,
   * expired, and wrong-secret alike, so the caller cannot be used as an
   * oracle for which keyIds exist.
   */
  async verify(presented: string): Promise<ApiKey | null> {
    const parsed = this.parse(presented);
    if (!parsed) return null;

    const key = await this.prisma.apiKey.findUnique({
      where: { keyId: parsed.keyId },
    });
    if (!key) return null;
    if (key.revokedAt) return null;
    if (key.expiresAt && key.expiresAt < new Date()) return null;

    const expected = Buffer.from(key.tokenHash, 'hex');
    const actual = sha256(parsed.secret);
    // Lengths are both 32 here by construction, but timingSafeEqual throws on
    // a mismatch rather than returning false, so guard before comparing.
    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    return key;
  }

  /**
   * Record usage, but only when the stored value is already stale.
   *
   * An unconditional write would turn every read by a polling client into an
   * UPDATE plus a row lock on one hot row, serialising that key's concurrent
   * requests behind each other. `lastUsedAt` is advisory — "roughly when was
   * this last used" — so a coarse resolution costs nothing and removes the
   * write from the hot path entirely.
   *
   * Deliberately fire-and-forget at the call site: a failed bookkeeping write
   * must never fail an otherwise-authenticated request.
   */
  async touch(key: Pick<ApiKey, 'id' | 'lastUsedAt'>): Promise<void> {
    const now = Date.now();
    if (key.lastUsedAt && now - key.lastUsedAt.getTime() < TOUCH_INTERVAL_MS) {
      return;
    }
    await this.prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date(now) },
    });
  }

  list(userId: string) {
    return this.prisma.apiKey.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      // tokenHash is never selected — it has no caller outside verify().
      select: {
        id: true,
        keyId: true,
        name: true,
        scopes: true,
        allowPasswordReveal: true,
        allowWrite: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Revoke every live key a user holds.
   *
   * Called from the paths a user reaches for when they suspect compromise —
   * changing their password, signing out everywhere — and from an admin MFA
   * reset. Without this, those actions kill every browser session while
   * leaving an attacker's key working, and the key is invisible on the
   * sessions page, so the user has no way to know it survived.
   *
   * Returns the number revoked so callers can report it.
   */
  async revokeAllForUser(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    return revokeApiKeysForUser(tx ?? this.prisma, userId);
  }

  /**
   * Audited mint. The audit row records the key's id, name and scopes — never
   * the secret (CLAUDE.md §2: audit the transition by reference, not value).
   */
  async create(actor: AuthedUser, dto: CreateApiKeyInput, meta: RequestMeta) {
    // A key minted while the switch is off would be dead on arrival, and the
    // user would copy a token that cannot work. Refuse up front instead.
    if (!(await this.settings.apiKeysEnabled())) {
      throw new ForbiddenException('API keys are turned off for this workspace.');
    }

    // Key row and audit row commit together. If the audit write fails the key
    // never exists: no unaudited credential (CLAUDE.md §2) and no live key the
    // caller never received.
    const { record, token } = await this.prisma.$transaction(async (tx) => {
      const minted = await this.mint(
        {
          userId: actor.id,
          name: dto.name,
          scopes: dto.scopes,
          expiresInDays: dto.expiresInDays,
          allowPasswordReveal: dto.allowPasswordReveal,
          allowWrite: dto.allowWrite,
          createdBy: actor.id,
        },
        tx,
      );
      await this.audit.logWithClient(tx, {
        actorId: actor.id,
        action: 'auth.api_key.create',
        entityType: 'api_key',
        entityId: minted.record.id,
        after: {
          name: minted.record.name,
          scopes: minted.record.scopes,
          expiresAt: minted.record.expiresAt,
          allowPasswordReveal: minted.record.allowPasswordReveal,
          allowWrite: minted.record.allowWrite,
          sessionId: actor.sessionId,
        },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return minted;
    });

    return {
      id: record.id,
      keyId: record.keyId,
      name: record.name,
      scopes: record.scopes,
      allowPasswordReveal: record.allowPasswordReveal,
      allowWrite: record.allowWrite,
      lastUsedAt: record.lastUsedAt,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      token,
    };
  }

  /**
   * Audited revoke, scoped to the acting user. A guessed id belonging to
   * someone else matches nothing and is indistinguishable from absent, so this
   * cannot be used to probe for other users' keys (CLAUDE.md §1).
   */
  async revoke(actor: AuthedUser, id: string, meta: RequestMeta): Promise<void> {
    const { count } = await this.prisma.apiKey.updateMany({
      where: { id, userId: actor.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException();

    await this.audit.log({
      actorId: actor.id,
      action: 'auth.api_key.revoke',
      entityType: 'api_key',
      entityId: id,
      after: { sessionId: actor.sessionId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
}
