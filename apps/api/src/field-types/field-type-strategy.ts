import type { FieldType } from '@weavestream/shared';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';

/**
 * Narrow interface over the Phase 3 `RelationService.replaceForField` method
 * so strategies can invalidate polymorphic link rows without importing the
 * full service (and therefore without a circular dependency between the
 * field-types module and the relations module).
 */
export interface RelationReplaceCtx {
  companyId: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  relationType: string;
  /** The normalized set of current target ids for this field. */
  targetIds: string[];
  actorId: string | null;
  tx: Prisma.TransactionClient;
}

export interface RelationPort {
  replaceForField(ctx: RelationReplaceCtx): Promise<void>;
}

/**
 * Context handed to `onRelate` so strategies can carry out side effects
 * (Relation upserts, cache busts) inside the same DB transaction as the
 * parent AssetFieldValue write.
 */
export interface FieldRelateCtx {
  companyId: string;
  assetId: string;
  field: {
    id: string;
    slug: string;
    options: Record<string, unknown>;
  };
  actorId: string | null;
  tx: Prisma.TransactionClient;
  relations: RelationPort;
}

/**
 * One FieldTypeStrategy per `FieldType`. The registry is the single source
 * of truth for: how to validate options at layout save time, how to
 * validate a stored value at asset save time, how to canonicalize on
 * write (phone → E.164, email → lowercase, etc.), how to materialize a
 * plaintext representation for Phase 6 search, and whether writes
 * need to update `Relation` rows (ASSET_REFERENCE only).
 */
export interface FieldTypeStrategy {
  readonly kind: FieldType;

  /** Validates `AssetField.options` at layout save time. */
  readonly optionsSchema: z.ZodTypeAny;

  /** Whether this field participates in Phase 6 text search. */
  readonly searchable: boolean;

  /** Builds a Zod schema for a *stored* value. `undefined` allows null. */
  valueSchema(options: Record<string, unknown>): z.ZodTypeAny;

  /**
   * Canonicalize an inbound value before persisting it. Strategies that
   * don't need normalization should return the input unchanged; the
   * resulting value must round-trip through `valueSchema`.
   */
  normalize(
    input: unknown,
    options: Record<string, unknown>,
  ): Prisma.InputJsonValue;

  /**
   * Plaintext view of a stored value, used by Phase 6 search (tsvector).
   * Strategies that have no plaintext representation (FILE, VAULTWARDEN_LINK)
   * return an empty string.
   */
  toPlaintext(value: unknown, options: Record<string, unknown>): string;

  /**
   * Called inside the asset-write transaction for field types that need to
   * synchronize external state (currently only ASSET_REFERENCE, which
   * upserts/deletes `Relation` rows via the injected RelationPort).
   */
  onRelate?(
    value: unknown,
    ctx: FieldRelateCtx,
  ): Promise<void>;
}
