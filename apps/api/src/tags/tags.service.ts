import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, Tag } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

/**
 * Audit metadata for `upsertByName` callers. Optional fields let callers
 * outside an HTTP scope (e.g. integration sync) still attribute the
 * audit row to an actor without inventing IP/UA values.
 */
export interface UpsertAuditMeta {
  actorId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface ListTagsOptions {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface SerializedTag {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/**
 * A large `OFFSET` forces Postgres into an O(n) scan-and-discard, so an
 * unbounded offset lets any authed user pin DB CPU with a tiny request.
 * Cap it; real depth should move to keyset pagination.
 */
const MAX_OFFSET = 10_000;

/**
 * Tags are global. Reads are open to every authenticated user; rename and
 * delete are gated by `tag.manage.global` (TAG_MANAGE / SUPER_ADMIN).
 *
 * Case-insensitive uniqueness is enforced by the app-maintained `nameLower`
 * column — `upsertByName` is the canonical entry point used by the asset
 * write path so inline-creation by any authed user is atomic with the
 * surrounding asset save.
 */
@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async list(options: ListTagsOptions = {}): Promise<SerializedTag[]> {
    const limit = clampLimit(options.limit);
    const offset = clampOffset(options.offset);
    const q = options.q?.trim();
    const where: Prisma.TagWhereInput = q
      ? { nameLower: { contains: q.toLowerCase() } }
      : {};
    const rows = await this.prisma.tag.findMany({
      where,
      orderBy: [{ nameLower: 'asc' }],
      take: limit,
      skip: offset,
    });
    return rows.map(serialize);
  }

  async getMany(ids: string[]): Promise<Map<string, SerializedTag>> {
    const map = new Map<string, SerializedTag>();
    if (ids.length === 0) return map;
    // Defensive filter: legacy `AssetFieldValue.value` rows from before the
    // global-Tag migration may still hold raw strings (e.g. "production")
    // instead of UUIDs. Passing those to Prisma's `id: { in: [...] }` on a
    // UUID column raises P2023 ("Error creating UUID"). The plan
    // explicitly chose not to migrate that data, so we silently drop any
    // non-UUID id here — the caller treats missing ids as deleted/unknown
    // and skips them on render.
    const unique = Array.from(new Set(ids.filter(isUuid)));
    if (unique.length === 0) return map;
    const rows = await this.prisma.tag.findMany({
      where: { id: { in: unique } },
    });
    for (const row of rows) map.set(row.id, serialize(row));
    return map;
  }

  /**
   * Idempotent upsert by `nameLower`. The first writer's casing wins for
   * the display `name`; subsequent calls with a different casing return
   * the same row without rewriting `name` (avoids churn on every save).
   *
   * When `audit` is supplied a `tag.create` row is written on the create
   * branch and only on the create branch — pure lookups (existing row)
   * stay silent so re-saving an asset doesn't pollute the audit log.
   * The `findUnique` pre-check is best-effort: a concurrent writer could
   * insert the row in the microsecond window before our `upsert`, in
   * which case we'd audit a "create" for an already-existing row. The
   * audit log is informational, the race is microsecond-scale, and using
   * a SAVEPOINT-scoped insert would complicate the asset-write tx for
   * negligible gain.
   */
  async upsertByName(
    name: string,
    tx?: Prisma.TransactionClient,
    audit?: UpsertAuditMeta | null,
  ): Promise<string> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new ConflictException({
        error: 'EmptyTagName',
        message: 'Tag name must not be empty.',
      });
    }
    const nameLower = trimmed.toLowerCase();
    const client = tx ?? this.prisma;

    const existing = await client.tag.findUnique({
      where: { nameLower },
      select: { id: true },
    });
    if (existing) return existing.id;

    const row = await client.tag.upsert({
      where: { nameLower },
      create: { name: trimmed, nameLower },
      update: {},
      select: { id: true, name: true },
    });

    if (audit) {
      await this.audit.log({
        actorId: audit.actorId,
        action: 'tag.create',
        entityType: 'Tag',
        entityId: row.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        before: null,
        after: { name: row.name },
      });
    }
    return row.id;
  }

  async create(
    actor: AuthedUser,
    name: string,
    meta: AuditMeta,
  ): Promise<SerializedTag> {
    const id = await this.upsertByName(name, undefined, {
      actorId: actor.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const row = await this.prisma.tag.findUniqueOrThrow({ where: { id } });
    return serialize(row);
  }

  async rename(
    actor: AuthedUser,
    id: string,
    name: string,
    meta: AuditMeta,
  ): Promise<SerializedTag> {
    const before = await this.prisma.tag.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    const trimmed = name.trim();
    const nameLower = trimmed.toLowerCase();
    if (nameLower !== before.nameLower) {
      const dupe = await this.prisma.tag.findUnique({ where: { nameLower } });
      if (dupe) {
        throw new ConflictException({
          error: 'TagNameTaken',
          message: `Tag "${trimmed}" already exists.`,
          conflictingTagId: dupe.id,
        });
      }
    }
    const row = await this.prisma.tag.update({
      where: { id },
      data: { name: trimmed, nameLower },
    });
    await this.audit.log({
      actorId: actor.id,
      action: 'tag.rename',
      entityType: 'Tag',
      entityId: row.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { name: before.name },
      after: { name: row.name },
    });
    return serialize(row);
  }

  /**
   * Hard delete. Dangling UUIDs left behind in `AssetFieldValue.value` are
   * dropped silently on read — the asset serializer joins ids → tags via
   * `getMany` and skips ids with no row. Cleaning up the JSON arrays would
   * require scanning every TAGS field value across every company, which is
   * not worth it for an operation that only happens at admin discretion.
   */
  async remove(
    actor: AuthedUser,
    id: string,
    meta: AuditMeta,
  ): Promise<void> {
    const before = await this.prisma.tag.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    await this.prisma.tag.delete({ where: { id } });
    await this.audit.log({
      actorId: actor.id,
      action: 'tag.delete',
      entityType: 'Tag',
      entityId: id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { name: before.name },
      after: null,
    });
  }
}

function serialize(row: Tag): SerializedTag {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function clampLimit(raw: number | undefined): number {
  if (!raw || raw <= 0) return DEFAULT_LIMIT;
  if (raw > MAX_LIMIT) return MAX_LIMIT;
  return raw;
}

function clampOffset(raw: number | undefined): number {
  if (!raw || raw <= 0) return 0;
  if (raw > MAX_OFFSET) return MAX_OFFSET;
  return raw;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
