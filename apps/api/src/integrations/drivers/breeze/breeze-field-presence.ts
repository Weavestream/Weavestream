import type { z } from 'zod';
import type { DriverObservedField } from '../integration-driver.js';
import {
  breezeRecordSchemaByEndpoint,
  type BreezeSourceEndpoint,
} from './breeze.schemas.js';

/**
 * Field-presence report for a Breeze page (`DriverFetchPage.observedFields`).
 *
 * The record schemas are a tolerant reader: a key Breeze omits becomes null
 * or an empty list. That keeps older and newer Breeze versions readable, but
 * it also means a renamed key reads as "empty", and an empty value can drop
 * a record. This report lets the runner tell the two apart: for each key the
 * schemas declare, it counts how many objects at that location carried the
 * key, from the RAW records. Paths come from the schemas themselves (no
 * second list to maintain), so keys Breeze or an operator define (custom
 * field values, JSON settings) are never walked or reported. Counts only,
 * never values.
 */

/** Most paths reported per endpoint, over all record variants. */
export const BREEZE_PRESENCE_MAX_PATHS = 512;
/** Deepest object nesting walked (a record is depth 0). */
export const BREEZE_PRESENCE_MAX_DEPTH = 5;
/** Most array items walked per list (the schemas allow at most 1000). */
const MAX_ITEMS_PER_LIST = 1_000;

export type ShapeNode = Map<string, ShapeEntry>;
export interface ShapeEntry {
  path: string;
  /** The key holds a list; `child` describes its items. */
  array: boolean;
  child: ShapeNode | null;
}

export interface PresencePlan {
  /** Union discriminator key, when records have variant shapes. */
  discriminator: string | null;
  /** Shape per variant; the key `''` is the only shape of a plain schema. */
  shapes: Map<string, ShapeNode>;
}

type ZodDef = {
  type: string;
  innerType?: z.ZodTypeAny;
  in?: z.ZodTypeAny;
  element?: z.ZodTypeAny;
  shape?: Record<string, z.ZodTypeAny>;
  options?: z.ZodTypeAny[];
  discriminator?: string;
  values?: unknown[];
};

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

/** Strip the wrappers the tolerant reader adds (nullish, transform, default). */
function unwrap(schema: z.ZodTypeAny): ZodDef {
  let def = defOf(schema);
  for (let guard = 0; guard < 16; guard += 1) {
    if (def.type === 'pipe' && def.in) def = defOf(def.in);
    else if (
      (def.type === 'optional' || def.type === 'nullable' || def.type === 'default' ||
        def.type === 'prefault' || def.type === 'readonly' || def.type === 'catch') &&
      def.innerType
    ) def = defOf(def.innerType);
    else break;
  }
  return def;
}

function buildShape(
  def: ZodDef,
  prefix: string,
  depth: number,
  budget: { remaining: number },
): ShapeNode {
  const node: ShapeNode = new Map();
  for (const [key, value] of Object.entries(def.shape ?? {})) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    const path = prefix ? `${prefix}.${key}` : key;
    const inner = unwrap(value);
    let child: ShapeNode | null = null;
    let array = false;
    if (inner.type === 'array' && inner.element) {
      array = true;
      const item = unwrap(inner.element);
      if (item.type === 'object' && depth < BREEZE_PRESENCE_MAX_DEPTH) {
        child = buildShape(item, `${path}[]`, depth + 1, budget);
      }
    } else if (inner.type === 'object' && depth < BREEZE_PRESENCE_MAX_DEPTH) {
      child = buildShape(inner, path, depth + 1, budget);
    }
    // Anything else (text, numbers, JSON, unions, records) is a leaf: only
    // the key itself is reported, never what is inside it.
    node.set(key, { path, array, child: child && child.size > 0 ? child : null });
  }
  return node;
}

function literalOf(option: ZodDef, key: string): string | null {
  const field = option.shape?.[key];
  if (!field) return null;
  const def = unwrap(field);
  const value = def.type === 'literal' ? def.values?.[0] : undefined;
  return typeof value === 'string' ? value : null;
}

/** The presence plan of one endpoint schema. Exported for tests. */
export function buildPresencePlan(schema: z.ZodTypeAny): PresencePlan {
  const def = unwrap(schema);
  const budget = { remaining: BREEZE_PRESENCE_MAX_PATHS };
  if (def.type === 'union' && def.discriminator && def.options) {
    const shapes = new Map<string, ShapeNode>();
    for (const option of def.options) {
      const optionDef = unwrap(option);
      const variant = literalOf(optionDef, def.discriminator);
      if (variant && optionDef.type === 'object') {
        shapes.set(variant, buildShape(optionDef, '', 0, budget));
      }
    }
    return { discriminator: def.discriminator, shapes };
  }
  return {
    discriminator: null,
    shapes: def.type === 'object'
      ? new Map([['', buildShape(def, '', 0, budget)]])
      : new Map(),
  };
}

const plans = new Map<BreezeSourceEndpoint, PresencePlan>();

function planFor(endpoint: BreezeSourceEndpoint): PresencePlan {
  let plan = plans.get(endpoint);
  if (!plan) {
    plan = buildPresencePlan(breezeRecordSchemaByEndpoint[endpoint]);
    plans.set(endpoint, plan);
  }
  return plan;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Count, per declared field path, how many objects at its location carried
 * the key. A key with a null value counts as present: null is an explicit
 * "empty", which is exactly what this report must tell apart from "not
 * sent". Records of a variant the schema does not declare are skipped (the
 * transform skips them too).
 */
export function observeBreezeFields(
  endpoint: BreezeSourceEndpoint,
  records: readonly unknown[],
): DriverObservedField[] {
  return observeWithPlan(planFor(endpoint), records);
}

/** Same as {@link observeBreezeFields} for a given plan. Exported for tests. */
export function observeWithPlan(
  plan: PresencePlan,
  records: readonly unknown[],
): DriverObservedField[] {
  const counters = new Map<string, DriverObservedField>();
  const count = (path: string, variant: string, present: boolean): void => {
    const key = `${variant}\u0000${path}`;
    let counter = counters.get(key);
    if (!counter) {
      counter = { path, ...(variant ? { variant } : {}), present: 0, objects: 0 };
      counters.set(key, counter);
    }
    counter.objects += 1;
    if (present) counter.present += 1;
  };
  const visit = (shape: ShapeNode, object: Record<string, unknown>, variant: string): void => {
    for (const [key, entry] of shape) {
      const present = Object.prototype.hasOwnProperty.call(object, key);
      count(entry.path, variant, present);
      if (!present || !entry.child) continue;
      const value = object[key];
      if (entry.array) {
        if (!Array.isArray(value)) continue;
        for (const item of value.slice(0, MAX_ITEMS_PER_LIST)) {
          if (isPlainObject(item)) visit(entry.child, item, variant);
        }
      } else if (isPlainObject(value)) {
        visit(entry.child, value, variant);
      }
    }
  };
  for (const record of records) {
    if (!isPlainObject(record)) continue;
    let variant = '';
    if (plan.discriminator) {
      const value = record[plan.discriminator];
      if (typeof value !== 'string' || !plan.shapes.has(value)) continue;
      variant = value;
    }
    const shape = plan.shapes.get(variant);
    if (shape) visit(shape, record, variant);
  }
  return [...counters.values()];
}
