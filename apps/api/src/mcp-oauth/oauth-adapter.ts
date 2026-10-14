import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Bearer artifacts: whoever holds the value can use it. Their rows are keyed
 * by the SHA-256 of the value and store the payload without it (`jti` is the
 * value for opaque tokens), so a database read never yields a usable code or
 * token. They are only ever looked up by their own value, so `find` can put
 * `jti` back from the caller's argument.
 *
 * Every other model keeps its provider id and full payload:
 *  - `Session` must round-trip through `findByUid` with its original id, or
 *    saving it again changes its identity. Safe to keep: 10 min TTL, and it
 *    grants nothing alone — every authorization needs consent with a live
 *    Weavestream session.
 *  - `Interaction` is useless without the browser's signed cookie.
 *  - `Grant` is useless without a token; `ReplayDetection` holds only the
 *    `jti` of a client assertion already used.
 */
const BEARER_MODELS = new Set(['AuthorizationCode', 'AccessToken', 'RefreshToken']);

/**
 * The library checks a client assertion's `jti` with "find, then save", so
 * two simultaneous uses of one assertion could both see no row. For this
 * model the save is an insert, and the primary key lets only one win.
 */
const INSERT_ONLY_MODELS = new Set(['ReplayDetection']);

/** Cap on the expired rows one write deletes on the side. */
const CLEANUP_BATCH = 100;

export interface OAuthAdapterDeps {
  prisma: PrismaService;
  /** The library's `errors.InvalidGrant`, loaded lazily with the library. */
  invalidGrant: (description: string) => Error;
  /** The library's `errors.InvalidClientAuth`, for a replayed client assertion. */
  invalidClientAuth: (description: string) => Error;
  /**
   * Called when a code or refresh token loses a consume race: the grant is
   * already deleted here, and the connection must be revoked with it.
   */
  onReplay: (grantId: string) => Promise<void>;
}

export function oauthAdapterFactory(deps: OAuthAdapterDeps): (name: string) => Adapter {
  return (name) => new PrismaOAuthAdapter(name, deps);
}

export class PrismaOAuthAdapter implements Adapter {
  private readonly bearer: boolean;

  constructor(
    private readonly name: string,
    private readonly deps: OAuthAdapterDeps,
  ) {
    this.bearer = BEARER_MODELS.has(name);
  }

  /** Row id: model-prefixed, hashed for bearer models. */
  key(id: string): string {
    return `${this.name}:${this.bearer ? createHash('sha256').update(id).digest('hex') : id}`;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const stored: Record<string, unknown> = { ...payload };
    if (this.bearer) delete stored.jti;
    const data = {
      kind: this.name,
      payload: stored as Prisma.InputJsonValue,
      // A grant's own row carries its id here, so deleting by grant id also
      // removes the grant.
      grantId: this.name === 'Grant' ? id : (payload.grantId ?? null),
      uid: payload.uid ?? null,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    };
    if (INSERT_ONLY_MODELS.has(this.name)) {
      await this.insertOnce(this.key(id), data);
    } else {
      await this.deps.prisma.oAuthArtifact.upsert({
        where: { id: this.key(id) },
        create: { id: this.key(id), ...data },
        update: data,
      });
    }
    await this.deleteSomeExpired();
  }

  /**
   * Insert, never overwrite. An expired row with the same id is cleared
   * first so a long-gone assertion cannot block a new one; a live one makes
   * the insert fail, and that use of the assertion is refused.
   */
  private async insertOnce(key: string, data: Omit<Prisma.OAuthArtifactCreateInput, 'id'>): Promise<void> {
    await this.deps.prisma.oAuthArtifact.deleteMany({ where: { id: key, expiresAt: { lt: new Date() } } });
    try {
      await this.deps.prisma.oAuthArtifact.create({ data: { id: key, ...data } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw this.deps.invalidClientAuth('client assertion tokens must only be used once');
      }
      throw err;
    }
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const row = await this.deps.prisma.oAuthArtifact.findUnique({ where: { id: this.key(id) } });
    return this.restore(row, id);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const row = await this.deps.prisma.oAuthArtifact.findFirst({ where: { kind: this.name, uid } });
    // Only non-bearer models are looked up by uid; their payload is complete.
    return this.restore(row, undefined);
  }

  async findByUserCode(): Promise<undefined> {
    // Device flow is disabled; nothing is ever stored by user code.
    return undefined;
  }

  /**
   * Atomic: of two simultaneous exchanges of one code or refresh token, only
   * one can flip `consumedAt`. The library checks `consumed` before calling
   * this, so without the conditional update both could be issued tokens. The
   * loser revokes the whole grant — the same outcome as a sequential replay.
   */
  async consume(id: string): Promise<void> {
    const key = this.key(id);
    const { count } = await this.deps.prisma.oAuthArtifact.updateMany({
      where: { id: key, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 1) return;
    const row = await this.deps.prisma.oAuthArtifact.findUnique({
      where: { id: key },
      select: { grantId: true },
    });
    if (row?.grantId) {
      await this.deps.prisma.oAuthArtifact.deleteMany({ where: { grantId: row.grantId } });
      await this.deps.onReplay(row.grantId);
    }
    throw this.deps.invalidGrant('grant request is invalid');
  }

  async destroy(id: string): Promise<void> {
    await this.deps.prisma.oAuthArtifact.deleteMany({ where: { id: this.key(id) } });
  }

  /**
   * Deletes this model's artifacts only. The library calls it once per model
   * when a grant ends; the connection itself is revoked from the
   * `grant.revoked` event, once.
   */
  async revokeByGrantId(grantId: string): Promise<void> {
    await this.deps.prisma.oAuthArtifact.deleteMany({ where: { kind: this.name, grantId } });
  }

  private restore(
    row: { payload: unknown; expiresAt: Date | null; consumedAt: Date | null } | null,
    presentedId: string | undefined,
  ): AdapterPayload | undefined {
    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;
    const payload = { ...(row.payload as Record<string, unknown>) } as AdapterPayload;
    if (this.bearer && presentedId !== undefined) payload.jti = presentedId;
    if (row.consumedAt) payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
    return payload;
  }

  /**
   * Expired rows are ignored on read; this keeps the table from growing
   * without a scheduled job. Best effort: a failure must not fail the write.
   */
  private async deleteSomeExpired(): Promise<void> {
    try {
      const stale = await this.deps.prisma.oAuthArtifact.findMany({
        where: { expiresAt: { lt: new Date() } },
        select: { id: true },
        take: CLEANUP_BATCH,
      });
      if (stale.length > 0) {
        await this.deps.prisma.oAuthArtifact.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
      }
    } catch {
      // Cleanup is housekeeping; the next write retries. Never fail a
      // successful upsert over it.
    }
  }
}
