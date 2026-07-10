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
  inputSchema: z.ZodTypeAny;
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
export function zodObjectToStrictJsonSchema(schema: z.ZodTypeAny): StrictJsonSchema {
  if (typeNameOf(schema) !== z.ZodFirstPartyTypeKind.ZodObject) {
    throw new Error(
      'zod-openai: a tool inputSchema must be a Zod object schema at the top level.',
    );
  }
  return convertObject(schema as z.ZodObject<z.ZodRawShape>, '$');
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>, path: string): StrictJsonSchema {
  const properties: Record<string, StrictJsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    properties[key] = convert(value, `${path}.${key}`);
    required.push(key);
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

function convert(schema: z.ZodTypeAny, path: string): StrictJsonSchema {
  // Unwrap Optional/Nullable/Default, remembering (a) that the field is
  // nullable in the emitted union and (b) the outermost description —
  // `.describe()` is usually called after `.optional()`, putting the
  // text on the wrapper rather than the inner type.
  let current: z.ZodTypeAny = schema;
  let nullable = false;
  let description: string | undefined;
  for (;;) {
    if (description === undefined && current.description !== undefined) {
      description = current.description;
    }
    const typeName = typeNameOf(current);
    if (
      typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
      typeName === z.ZodFirstPartyTypeKind.ZodNullable
    ) {
      nullable = true;
      current = (current as z.ZodOptional<z.ZodTypeAny>).unwrap();
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
      nullable = true;
      current = (current as z.ZodDefault<z.ZodTypeAny>).removeDefault();
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

function convertBase(schema: z.ZodTypeAny, path: string): StrictJsonSchema {
  const typeName = typeNameOf(schema);
  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return { type: 'string' };
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const isInt = (schema as z.ZodNumber)._def.checks.some(
        (c) => c.kind === 'int',
      );
      return { type: isInt ? 'integer' : 'number' };
    }
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return {
        type: 'string',
        enum: [...(schema as z.ZodEnum<[string, ...string[]]>)._def.values],
      };
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const def = (schema as z.ZodArray<z.ZodTypeAny>)._def;
      const items = convert(def.type, `${path}[]`);
      return def.maxLength !== null
        ? { type: 'array', items, maxItems: def.maxLength.value }
        : { type: 'array', items };
    }
    case z.ZodFirstPartyTypeKind.ZodObject:
      return convertObject(schema as z.ZodObject<z.ZodRawShape>, path);
    default:
      throw new Error(
        `zod-openai: unsupported Zod type "${String(typeName)}" at ${path}. ` +
          'Tool input schemas may only use object/string/number/boolean/enum/array ' +
          'plus optional/nullable/default wrappers and .describe().',
      );
  }
}

function typeNameOf(schema: z.ZodTypeAny): z.ZodFirstPartyTypeKind {
  return (schema._def as { typeName: z.ZodFirstPartyTypeKind }).typeName;
}
