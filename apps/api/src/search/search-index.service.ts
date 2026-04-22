import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';

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
 * strategy (FILE, VAULTWARDEN_LINK, ASSET_REFERENCE). Strategies
 * render via `toPlaintext`, which handles per-value canonicalisation
 * (dropdown slug → label, tiptap doc → flattened text, etc.).
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
   * Rebuild the `search_index` row for a single asset. Intended to be
   * called with a transaction client so the index update commits
   * atomically with the asset and field-value writes it reflects.
   * When the asset has been hard-deleted since the call was issued
   * (rare; asset deletion is `Restrict` for layouts), we silently no-op
   * — the trigger path will have already removed the row.
   */
  async upsertAsset(
    tx: Prisma.TransactionClient | PrismaService,
    assetId: string,
  ): Promise<void> {
    const client = tx as PrismaService;
    const asset = await client.asset.findUnique({
      where: { id: assetId },
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

    const { title, bodyPublic, bodyInternal } = this.buildAssetBodies(asset);

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
   * field has its `visibleToClients` flipped or a field is archived,
   * so the stale `body_public` is rebuilt for every row. Batched to
   * keep transactions small on layouts with thousands of assets.
   */
  async reindexLayout(layoutId: string, batchSize = 200): Promise<number> {
    let done = 0;
    let cursor: string | undefined;

    while (true) {
      const batch = await this.prisma.asset.findMany({
        where: { assetLayoutId: layoutId },
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true },
      });
      if (batch.length === 0) break;
      for (const row of batch) {
        await this.upsertAsset(this.prisma, row.id);
        done += 1;
      }
      cursor = batch[batch.length - 1]!.id;
      if (batch.length < batchSize) break;
    }
    return done;
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
  }> {
    const counts = {
      assets: 0,
      articles: 0,
      uploads: 0,
      domains: 0,
      passwords: 0,
    };

    const assetIds = await this.prisma.asset.findMany({
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    for (const { id } of assetIds) {
      await this.upsertAsset(this.prisma, id);
      counts.assets += 1;
    }

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
      `reindex-search: ${counts.assets} assets, ${counts.articles} articles, ${counts.uploads} uploads, ${counts.domains} domains, ${counts.passwords} passwords`,
    );
    return counts;
  }

  // ------------------------------------------------------------------
  // Pure helpers (easy to unit-test)
  // ------------------------------------------------------------------

  /**
   * Build `title`, `body_public`, `body_internal` for an asset + its
   * field rows. Exposed so unit tests can assert that fields with
   * `visibleToClients = false` stay out of `body_public`. Archived
   * fields are excluded up front.
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
  }): { title: string; bodyPublic: string; bodyInternal: string } {
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
      const plaintext = strategy.toPlaintext(row.value, options).trim();
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
