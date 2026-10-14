import { z } from 'zod';

/**
 * Zod → OpenAI strict tool-definition converter.
 *
 * The chat tool catalog must be emitted in one exact shape (see the
 * design notes in `apps/api/src/chat/chat-tools.ts`): `strict: true`,
 * `additionalProperties: false`, EVERY property listed in `required`,
 * and optional fields typed as a `["T","null"]` union. On vLLM this
 * opts `tool_choice: 'auto'` into structural-tag constraints; without
 * it, arguments are scraped from raw text and can be malformed.
 *
 * A generic zod-to-json-schema dependency emits `anyOf`/`nullable`
 * variants that do NOT match that shape and whose output can drift
 * across minor versions, so this is a deliberate local converter for
 * exactly the Zod subset the tool schemas use. Anything outside the
 * subset throws — at module load (the catalog is built at import time)
 * and in tests, never at request time.
 *
 * Deliberate parity choices with the previous hand-written catalog:
 * string min/max and numeric bounds are NOT emitted (server-side Zod
 * still enforces them); array `maxItems` IS emitted.
 */

export type StrictJsonSchema = Record<string, unknown>;

export interface OpenAiFunctionTool {
  type: 'function';
  function: {
    name: string;
    strict: true;
    description: string;
    parameters: StrictJsonSchema;
  };
}

/** The minimal spec surface the converter needs (satisfied by AiToolSpec). */
export interface AiToolDefSource {
  name: string;
  description: string;
  /** Must be a Zod object schema — verified at conversion time. */
  inputSchema: z.ZodType;
}

export function toOpenAiToolDef(spec: AiToolDefSource): OpenAiFunctionTool {
  return {
    type: 'function',
    function: {
      name: spec.name,
      strict: true,
      description: spec.description,
      parameters: zodObjectToStrictJsonSchema(spec.inputSchema),
    },
  };
}

/**
 * Convert a Zod object schema into the strict parameters shape. All
 * keys land in `required`; `.optional()` / `.nullable()` / `.default()`
 * wrappers become the `["T","null"]` type union instead.
 */
export function zodObjectToStrictJsonSchema(schema: z.ZodType): StrictJsonSchema {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      'zod-openai: a tool inputSchema must be a Zod object schema at the top level.',
    );
  }
  return convertObject(schema, '$');
}

function convertObject(schema: z.ZodObject, path: string): StrictJsonSchema {
  const properties: Record<string, StrictJsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    properties[key] = convert(value as z.ZodType, `${path}.${key}`);
    required.push(key);
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

function convert(schema: z.ZodType, path: string): StrictJsonSchema {
  // Unwrap Optional/Nullable/Default, remembering (a) that the field is
  // nullable in the emitted union and (b) the outermost description —
  // `.describe()` is usually called after `.optional()`, putting the
  // text on the wrapper rather than the inner type.
  let current: z.ZodType = schema;
  let nullable = false;
  let description: string | undefined;
  for (;;) {
    if (description === undefined && current.description !== undefined) {
      description = current.description;
    }
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      nullable = true;
      current = current.unwrap() as z.ZodType;
      continue;
    }
    break;
  }

  const base = convertBase(current, path);
  const withNull = nullable
    ? { ...base, type: [base['type'] as string, 'null'] }
    : base;
  return description !== undefined
    ? { ...withNull, description }
    : withNull;
}

function convertBase(schema: z.ZodType, path: string): StrictJsonSchema {
  // Dispatch on `def.type`, not `instanceof`: Zod 4 string formats such as
  // `z.guid()` have `def.type === 'string'` but are not `ZodString` instances.
  switch (schema.def.type) {
    case 'string':
      return { type: 'string' };
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return { type: (schema as z.ZodNumber).isInt ? 'integer' : 'number' };
    case 'enum':
      return { type: 'string', enum: [...(schema as z.ZodEnum).options] };
    case 'array': {
      const array = schema as z.ZodArray;
      const items = convert(array.element as z.ZodType, `${path}[]`);
      const maxItems = arrayMaxItems(array);
      return maxItems !== undefined
        ? { type: 'array', items, maxItems }
        : { type: 'array', items };
    }
    case 'object':
      return convertObject(schema as z.ZodObject, path);
    default:
      throw new Error(
        `zod-openai: unsupported Zod type "${schema.def.type}" at ${path}. ` +
          'Tool input schemas may only use object/string/number/boolean/enum/array ' +
          'plus optional/nullable/default wrappers and .describe().',
      );
  }
}

/**
 * The tightest `.max(n)` on an array. Zod 4 has no public getter for it: the
 * bound lives on the `max_length` check in `def.checks`.
 */
function arrayMaxItems(schema: z.ZodArray): number | undefined {
  let max: number | undefined;
  for (const check of schema.def.checks ?? []) {
    const def = check._zod.def as { check: string; maximum?: number };
    if (def.check === 'max_length' && def.maximum !== undefined) {
      max = max === undefined ? def.maximum : Math.min(max, def.maximum);
    }
  }
  return max;
}
