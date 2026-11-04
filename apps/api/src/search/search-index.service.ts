import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { runInCompanyScope } from '../prisma/company-scope.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { escapeLikePattern } from '../common/like-pattern.js';
import { validTagIds } from '../tags/tag-ids.js';
import { refreshMarkdownPlaintext } from './markdown-plaintext-refresh.service.js';

/** Most words one asset list search term may have. */
export const MAX_SEARCH_WORDS = 8;
/** Longest asset list search term, in characters after trimming. */
export const MAX_SEARCH_LENGTH = 200;

/**
 * The words of one asset list search term. A term over the limits is
 * refused with a 400, never cut: a cut term would silently drop words
 * and return assets that do not match the whole search.
 */
export function assetSearchWords(term: string): string[] {
  const trimmed = term.trim();
  if (trimmed.length > MAX_SEARCH_LENGTH) {
    throw new BadRequestException({
      error: 'SearchTermTooLong',
      message: `A search term can have at most ${MAX_SEARCH_LENGTH} characters.`,
    });
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > MAX_SEARCH_WORDS) {
    throw new BadRequestException({
      error: 'SearchTermTooLong',
      message: `A search term can have at most ${MAX_SEARCH_WORDS} words.`,
    });
  }
  return words;
}

/**
 * Phase 6 search-index writer. Responsible for keeping `search_index`
 * in sync for assets (articles + uploads are trigger-maintained in
 * the database itself — see
 * `packages/db/prisma/migrations/0009_phase6_search_index/migration.sql`).
 *
 * The body of an asset row is rebuilt from its field values on every
 * write. We generate two plaintext blobs per asset:
 *
 *   body_public   — only fields with `visible_to_clients = true`
 *   body_internal — every non-sensitive searchable field
 *
 * The DB then materialises two `GENERATED tsvector` columns from
 * those blobs plus the title, weighted `A` for title and `B` for
 * body. `SearchService` queries against `body_public_tsv` for
 * CLIENT_USER callers and `body_internal_tsv` for operators, so the
 * same row can be reused across visibility scopes without fighting
 * Postgres' row-level security story.
 *
 * Field types opt out by setting `searchable = false` on their
 * strategy (BOOLEAN, VAULTWARDEN_LINK, ASSET_REFERENCE). Strategies
 * render via `toPlaintext`, which handles per-value canonicalisation
 * (dropdown slug → label, tiptap doc → flattened text, etc.). TAGS
 * values are tag ids; `upsertAsset` resolves them to names.
 *
 * The same rows serve the asset list `q` search (`matchAssetIds`).
 */
@Injectable()
export class SearchIndexService {
  private readonly logger = new Logger(SearchIndexService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: FieldTypesRegistry,
  ) {}

  // ------------------------------------------------------------------
  // Asset path — called from AssetsService write transactions.
  // ------------------------------------------------------------------

  /**
   * Rebuild the `search_index` row for a single asset, inside the
   * caller's transaction so the index update commits atomically with
   * the asset and field-value writes it reflects. Reindex paths with no
   * transaction of their own use `rebuildAsset`. When the asset has been
   * hard-deleted since the call was issued (rare; asset deletion is
   * `Restrict` for layouts), we silently no-op — the trigger path will
   * have already removed the row.
   *
   * The first statement locks the asset row, so 2 rebuilds of one asset
   * never interleave: the one that gets the lock last also writes last.
   * Under READ COMMITTED every read below takes a fresh snapshot after
   * the lock, so that rebuild sees every commit before it. Without the
   * lock a slow rebuild (the backfill) could read a field as client
   * visible, and then write that text into `body_public` after the
   * layout reindex for "field hidden" had already corrected it.
   *
   * `companyId` scopes the read so the tenant middleware accepts it for
   * operators pinned to their memberships (issue #109).
   */
  async upsertAsset(
    tx: Prisma.TransactionClient,
    assetId: string,
    companyId: string,
  ): Promise<void> {
    await this.lockAsset(tx, assetId, companyId);
    const client = tx;
    const asset = await client.asset.findFirst({
      where: { id: assetId, companyId },
      include: {
        assetLayout: {
          include: {
            fields: { where: { archivedAt: null } },
          },
        },
        fieldValues: true,
      },
    });
    if (!asset) return;

    const tagNames = await this.resolveTagNames(client, asset);
    const { title, bodyPublic, bodyInternal } = this.buildAssetBodies(asset, tagNames);

    await client.$executeRaw`
      INSERT INTO "search_index" (
        "entity_type", "entity_id", "company_id", "title",
        "body_public", "body_internal", "visible_to_clients",
        "layout_id", "archived_at", "updated_at"
      ) VALUES (
        'asset',
        ${asset.id}::uuid,
        ${asset.companyId}::uuid,
        ${title},
        ${bodyPublic},
        ${bodyInternal},
        true,
        ${asset.assetLayoutId}::uuid,
        ${asset.archivedAt},
        ${asset.updatedAt}
      )
      ON CONFLICT ("entity_type", "entity_id") DO UPDATE
      SET "company_id"         = EXCLUDED."company_id",
          "title"              = EXCLUDED."title",
          "body_public"        = EXCLUDED."body_public",
          "body_internal"      = EXCLUDED."body_internal",
          "visible_to_clients" = EXCLUDED."visible_to_clients",
          "layout_id"          = EXCLUDED."layout_id",
          "archived_at"        = EXCLUDED."archived_at",
          "updated_at"         = EXCLUDED."updated_at";
    `;
  }

  /**
   * `upsertAsset` in a transaction of its own. Used by every reindex
   * path (layout, tag, backfill, full reindex) so they take the same
   * per-asset row lock as the asset write paths.
   */
  async rebuildAsset(assetId: string, companyId: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.upsertAsset(tx, assetId, companyId));
  }

  /**
   * Asset ids in one company whose name or indexed field text contains
   * every word of `q` (case-insensitive, `%`/`_` matched literally).
   * Backs the asset list `q` filter. Words may match different fields,
   * so "dell 5420" finds a Dell whose model is 5420.
   *
   * `search_index` is not a tenant-scoped model in the Prisma
   * middleware, so the `companyId` condition below IS the tenant scope:
   * callers pass the company already authorized for the request.
   * `clientVisibleOnly` (CLIENT_USER) reads `body_public`, the same
   * rule as `SearchService.search`, so text in a field hidden from
   * clients never makes an asset match for them.
   */
  async matchAssetIds(
    companyId: string,
    q: string,
    opts: { clientVisibleOnly: boolean },
  ): Promise<string[]> {
    const words = assetSearchWords(q);
    if (words.length === 0) return [];

    const bodyField = opts.clientVisibleOnly ? 'bodyPublic' : 'bodyInternal';
    const rows = await this.prisma.searchIndex.findMany({
      where: {
        entityType: 'asset',
        companyId,
        AND: words.map((word) => {
          const pattern = escapeLikePattern(word);
          return {
            OR: [
              { title: { contains: pattern, mode: 'insensitive' as const } },
              { [bodyField]: { contains: pattern, mode: 'insensitive' as const } },
            ],
          };
        }),
      },
      select: { entityId: true },
    });
    return rows.map((r) => r.entityId);
  }

  /**
   * Remove an asset row from the index. Used on hard delete (rare —
   * assets are almost always archived, not deleted) and as a safety
   * net in the reindex CLI when the source row has disappeared.
   */
  async removeAsset(
    tx: Prisma.TransactionClient | PrismaService,
    assetId: string,
  ): Promise<void> {
    const client = tx as PrismaService;
    await client.$executeRaw`
      DELETE FROM "search_index"
      WHERE "entity_type" = 'asset' AND "entity_id" = ${assetId}::uuid;
    `;
  }

  /**
   * Re-upsert every asset belonging to a layout. Called after a layout
   * field has its `visibleToClients` flipped, a field is archived, or
   * the choices of a DROPDOWN/MULTISELECT field change, so the stale
   * text is rebuilt for every row.
   */
  async reindexLayout(layoutId: string, batchSize = 200): Promise<number> {
    return this.reindexAssetsWhere({ assetLayoutId: layoutId }, batchSize);
  }

  /**
   * Re-upsert every asset that holds a tag in a TAGS field. Called after
   * the tag is renamed or deleted, because the index holds tag names.
   * After a delete the field values still hold the dangling id, so the
   * same query finds the assets and the old name drops out.
   */
  async reindexAssetsWithTag(tagId: string, batchSize = 200): Promise<number> {
    return this.reindexAssetsWhere(
      {
        fieldValues: {
          some: {
            assetField: { fieldType: 'TAGS' },
            value: { array_contains: [tagId] },
          },
        },
      },
      batchSize,
    );
  }

  /** Re-upsert every asset. Used by `reindexAll` and the boot backfill. */
  async reindexAssets(batchSize = 200): Promise<number> {
    return this.reindexAssetsWhere({}, batchSize);
  }

  /**
   * Rebuild every asset matching `where`, in id-ordered batches to keep
   * reads small on large tenants. Each asset is rebuilt in its own
   * short transaction (`rebuildAsset`).
   *
   * Layouts and tags are global, so their assets span every company.
   * The caller is authorized by a global capability
   * (`layout.manage.global`, `tag.manage.global`) or is a system process
   * (CLI, boot backfill) and may hold no membership, so the reads run in
   * an explicit all-company scope (`runInCompanyScope`). Nothing read
   * here goes back to the caller: the only output is the derived
   * `search_index` rows.
   */
  private async reindexAssetsWhere(
    where: Prisma.AssetWhereInput,
    batchSize: number,
  ): Promise<number> {
    const companies = await this.prisma.company.findMany({ select: { id: true } });
    const companyIds = companies.map((c) => c.id);
    if (companyIds.length === 0) return 0;

    return runInCompanyScope(companyIds, async () => {
      let done = 0;
      let cursor: string | undefined;

      while (true) {
        const batch = await this.prisma.asset.findMany({
          where: { ...where, companyId: { in: companyIds } },
          orderBy: { id: 'asc' },
          take: batchSize,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, companyId: true },
        });
        if (batch.length === 0) break;
        for (const row of batch) {
          await this.rebuildAsset(row.id, row.companyId);
          done += 1;
        }
        cursor = batch[batch.length - 1]!.id;
        if (batch.length < batchSize) break;
      }
      return done;
    });
  }

  // ------------------------------------------------------------------
  // Full reindex — used from the CLI on first boot / after bulk ops.
  // ------------------------------------------------------------------

  /**
   * Re-scans every asset, article, and upload and rewrites its
   * `search_index` row. Article + Upload rows are trigger-maintained
   * in steady state, but a bulk SQL import (seed scripts, NinjaOne
   * sync in Phase 7, restore from backup) can bypass the triggers;
   * this method rebuilds the whole table defensively.
   */
  async reindexAll(): Promise<{
    assets: number;
    articles: number;
    uploads: number;
    domains: number;
    passwords: number;
    markdownRefreshed: number;
  }> {
    const counts = {
      assets: 0,
      articles: 0,
      uploads: 0,
      domains: 0,
      passwords: 0,
      markdownRefreshed: 0,
    };

    counts.assets = await this.reindexAssets();

    counts.markdownRefreshed = await refreshMarkdownPlaintext(this.prisma);

    // Articles + uploads: touch each row so the trigger re-fires. A
    // `WHERE id = id` update is a Postgres no-op for the row itself
    // but still causes the AFTER UPDATE trigger to run, which keeps
    // the plaintext / visibility / archived_at mirror in sync.
    const articleCount = await this.prisma.$executeRaw`
      UPDATE "articles" SET "updated_at" = "updated_at";
    `;
    const uploadCount = await this.prisma.$executeRaw`
      UPDATE "uploads" SET "created_at" = "created_at"
      WHERE "deleted_at" IS NULL;
    `;
    // Domain rows are trigger-maintained in Phase 8; touch updated_at
    // to re-fire the trigger after a restore-from-backup sweep.
    const domainCount = await this.prisma.$executeRaw`
      UPDATE "monitored_domains" SET "updated_at" = "updated_at";
    `;
    // Passwords: trigger-maintained since migration 0017. Searchable
    // body is non-secret metadata only (name/username/url/tags); the
    // ciphertext columns are never fed into the tsvector.
    const passwordCount = await this.prisma.$executeRaw`
      UPDATE "passwords" SET "updated_at" = "updated_at";
    `;
    counts.articles = Number(articleCount ?? 0);
    counts.uploads = Number(uploadCount ?? 0);
    counts.domains = Number(domainCount ?? 0);
    counts.passwords = Number(passwordCount ?? 0);

    this.logger.log(
      `reindex-search: ${counts.assets} assets, ${counts.articles} articles (${counts.markdownRefreshed} Markdown plaintexts refreshed), ${counts.uploads} uploads, ${counts.domains} domains, ${counts.passwords} passwords`,
    );
    return counts;
  }

  /**
   * Row lock that serializes rebuilds of one asset (see `upsertAsset`).
   * A missing row locks nothing; the read after it then no-ops.
   */
  private async lockAsset(
    tx: Prisma.TransactionClient,
    assetId: string,
    companyId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT 1 FROM "assets"
      WHERE "id" = ${assetId}::uuid AND "company_id" = ${companyId}::uuid
      FOR UPDATE
    `;
  }

  /**
   * `id -> name` for the tags held in the asset's live TAGS fields.
   * Reads on the caller's transaction, so a tag created by the same
   * asset write (`TagsService.upsertByName(tx)`) is found. Legacy
   * non-UUID values are dropped first (`validTagIds`); a lookup with one
   * of them would fail the whole rebuild.
   */
  private async resolveTagNames(
    tx: Prisma.TransactionClient,
    asset: {
      assetLayout: { fields: Array<{ id: string; fieldType: string }> };
      fieldValues: Array<{ assetFieldId: string; value: unknown }>;
    },
  ): Promise<Map<string, string>> {
    const tagFieldIds = new Set(
      asset.assetLayout.fields.filter((f) => f.fieldType === 'TAGS').map((f) => f.id),
    );
    const values = asset.fieldValues
      .filter((v) => tagFieldIds.has(v.assetFieldId) && Array.isArray(v.value))
      .flatMap((v) => v.value as unknown[]);
    const ids = validTagIds(values);
    if (ids.length === 0) return new Map();

    const tags = await tx.tag.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(tags.map((t) => [t.id, t.name]));
  }

  // ------------------------------------------------------------------
  // Pure helpers (easy to unit-test)
  // ------------------------------------------------------------------

  /**
   * Build `title`, `body_public`, `body_internal` for an asset + its
   * field rows. Exposed so unit tests can assert that fields with
   * `visibleToClients = false` stay out of `body_public`. Archived
   * fields are excluded up front. `tagNames` maps the tag ids stored in
   * TAGS values to names (see `resolveTagNames`); unknown ids drop out.
   *
   * Secondary plaintext store — `body_internal` retains all searchable
   * field text incl. hidden fields (accepted, WS-004). See
   * docs/security/data-retention.md.
   */
  buildAssetBodies(asset: {
    name: string;
    assetLayout: {
      fields: Array<{
        id: string;
        slug: string;
        fieldType: string;
        visibleToClients: boolean;
        archivedAt: Date | null;
        options: unknown;
      }>;
    };
    fieldValues: Array<{ assetFieldId: string; value: unknown }>;
  }, tagNames: ReadonlyMap<string, string> = new Map()): {
    title: string;
    bodyPublic: string;
    bodyInternal: string;
  } {
    const title = asset.name ?? '';
    const fieldById = new Map(
      asset.assetLayout.fields
        .filter((f) => f.archivedAt === null)
        .map((f) => [f.id, f]),
    );

    const publicChunks: string[] = [];
    const internalChunks: string[] = [];

    for (const row of asset.fieldValues) {
      const field = fieldById.get(row.assetFieldId);
      if (!field) continue;

      let strategy;
      try {
        strategy = this.registry.get(field.fieldType as never);
      } catch {
        continue;
      }
      if (!strategy.searchable) continue;

      const options = (field.options as Record<string, unknown> | null) ?? {};
      const plaintext = (
        field.fieldType === 'TAGS'
          ? tagPlaintext(row.value, tagNames)
          : strategy.toPlaintext(row.value, options)
      ).trim();
      if (!plaintext) continue;

      internalChunks.push(plaintext);
      if (field.visibleToClients) publicChunks.push(plaintext);
    }

    return {
      title,
      bodyPublic: publicChunks.join('\n'),
      bodyInternal: internalChunks.join('\n'),
    };
  }
}

/** Names of the tags in a TAGS value, space separated; unknown ids drop out. */
function tagPlaintext(value: unknown, tagNames: ReadonlyMap<string, string>): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((id) => (typeof id === 'string' ? tagNames.get(id) ?? '' : ''))
    .filter(Boolean)
    .join(' ');
}
