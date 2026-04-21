import { z } from 'zod';
import type { AssetField } from '@prisma/client';
import type { UserRole } from '@weavestream/shared';
import type { FieldTypesRegistry } from '../field-types/field-types.registry.js';

/**
 * Phase 3 dynamic asset validator.
 *
 * `buildAssetZodSchema(fields, registry, { mode, role })` returns a
 * `z.object().strict()` whose keys are the layout's field slugs and whose
 * per-key schema is the matching `FieldTypeStrategy.valueSchema(options)`
 * — nullable+optional for non-required fields. Strict mode rejects unknown
 * slugs so a malformed client can never store ghost keys.
 *
 * Role-filtering (CLIENT_* can't write invisible fields) is enforced at
 * write time by removing `visibleToClients === false` fields from the
 * candidate set before shape construction.
 *
 * Because the schema is rebuilt per request, layout edits between
 * requests are reflected immediately with no cache invalidation.
 */
export interface BuildAssetSchemaOptions {
  /** `'write'` treats required fields as required; `'update'` makes every field optional. */
  mode: 'write' | 'update';
  /** When provided, fields with `visibleToClients === false` are dropped for CLIENT_*. */
  role?: UserRole;
}

function isClientRole(role?: UserRole): boolean {
  return role === 'CLIENT_USER';
}

export function buildAssetZodSchema(
  fields: AssetField[],
  registry: FieldTypesRegistry,
  opts: BuildAssetSchemaOptions,
): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};

  for (const field of fields) {
    if (field.archivedAt !== null) continue;
    if (isClientRole(opts.role) && !field.visibleToClients) continue;

    const strategy = registry.get(field.fieldType);
    const options = (field.options ?? {}) as Record<string, unknown>;
    const base = strategy.valueSchema(options);

    if (opts.mode === 'update' || !field.isRequired) {
      shape[field.slug] = base.nullable().optional();
    } else {
      shape[field.slug] = base.refine(
        (v) => v !== null && v !== undefined && v !== '',
        { message: `${field.name} is required` },
      );
    }
  }

  return z.object(shape).strict();
}
