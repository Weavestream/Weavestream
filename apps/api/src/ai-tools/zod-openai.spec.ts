import { z } from 'zod';
import { toOpenAiToolDef, zodObjectToStrictJsonSchema } from './zod-openai.js';
import { AI_TOOL_SPECS } from './tool-specs.js';

/**
 * Byte-parity contract: the converter must reproduce the previously
 * hand-written `ARTICLE_TOOLS` catalog EXACTLY. This frozen copy is the
 * catalog as it shipped before the registry existed — the shape is
 * load-bearing for vLLM structural-tag constraints (strict, all
 * properties required, optionals as ["T","null"] unions), so any
 * converter change that breaks parity here would silently degrade
 * tool-call reliability in production.
 */
const LEGACY_ARTICLE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'update_article',
      strict: true,
      description: [
        'Propose an update to an existing article. The change is NOT',
        'applied immediately — the user sees a diff and clicks Apply',
        'or Reject in the chat UI. Provide the full new markdown body',
        '(do not send a partial diff). The article will be saved in',
        'Markdown editor mode regardless of its current mode.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          article_id: {
            type: 'string',
            description:
              'UUID of the article to update. Must match one of the article ids shown in the system context.',
          },
          title: {
            type: ['string', 'null'],
            description: 'New title. Use null to keep the existing title.',
          },
          markdown: {
            type: ['string', 'null'],
            description:
              'Full replacement markdown body. Required to change content; use null when only changing the title.',
          },
          summary: {
            type: ['string', 'null'],
            description:
              'One-line natural-language summary of the change shown to the user above the diff. null if none.',
          },
        },
        required: ['article_id', 'title', 'markdown', 'summary'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_article',
      strict: true,
      description: [
        'Propose creating a new article. The article is NOT created',
        'immediately — the user reviews the proposed title and body',
        'and clicks Apply or Reject in the chat UI. New articles are',
        'created in Markdown editor mode.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          markdown: {
            type: 'string',
            description: 'Article body as markdown.',
          },
          folder_id: {
            type: ['string', 'null'],
            description:
              'UUID of the parent folder. Use null to create the article at the root.',
          },
          visible_to_clients: {
            type: ['boolean', 'null'],
            description: 'Defaults to true. Use null for the default.',
          },
          summary: {
            type: ['string', 'null'],
            description:
              'One-line summary shown to the user above the preview. null if none.',
          },
        },
        required: ['title', 'markdown', 'folder_id', 'visible_to_clients', 'summary'],
      },
    },
  },
];

describe('toOpenAiToolDef', () => {
  it('reproduces the legacy hand-written update_article definition exactly', () => {
    expect(toOpenAiToolDef(AI_TOOL_SPECS.update_article)).toEqual(
      LEGACY_ARTICLE_TOOLS[0],
    );
  });

  it('reproduces the legacy hand-written create_article definition exactly', () => {
    expect(toOpenAiToolDef(AI_TOOL_SPECS.create_article)).toEqual(
      LEGACY_ARTICLE_TOOLS[1],
    );
  });

  it('emits strict mode with every read-tool property in required', () => {
    for (const name of [
      'search',
      'find_related_items',
      'get_article',
      'get_related_items',
    ] as const) {
      const def = toOpenAiToolDef(AI_TOOL_SPECS[name]);
      expect(def.function.strict).toBe(true);
      const params = def.function.parameters as {
        additionalProperties: boolean;
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(params.additionalProperties).toBe(false);
      expect(params.required.sort()).toEqual(Object.keys(params.properties).sort());
    }
  });

  it('renders the zero-argument company summary tool as an empty strict object', () => {
    const def = toOpenAiToolDef(AI_TOOL_SPECS.get_company_summary);
    expect(def.function.parameters).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    });
  });
});

describe('zodObjectToStrictJsonSchema', () => {
  it('converts enums to string type with enum values', () => {
    const schema = zodObjectToStrictJsonSchema(
      z.object({ kind: z.enum(['a', 'b']).describe('Kind.') }),
    );
    expect(schema['properties']).toEqual({
      kind: { type: 'string', enum: ['a', 'b'], description: 'Kind.' },
    });
  });

  it('converts optional arrays to a ["array","null"] union with items and maxItems', () => {
    const schema = zodObjectToStrictJsonSchema(
      z.object({ types: z.array(z.enum(['x', 'y'])).min(1).max(5).optional() }),
    );
    expect(schema['properties']).toEqual({
      types: {
        type: ['array', 'null'],
        items: { type: 'string', enum: ['x', 'y'] },
        maxItems: 5,
      },
    });
    expect(schema['required']).toEqual(['types']);
  });

  it('distinguishes integers from numbers and unions optionals with null', () => {
    const schema = zodObjectToStrictJsonSchema(
      z.object({
        count: z.number().int().min(1).max(10).optional(),
        score: z.number(),
      }),
    );
    expect(schema['properties']).toEqual({
      count: { type: ['integer', 'null'] },
      score: { type: 'number' },
    });
  });

  it('collapses nested optional/nullable wrappers into a single null union', () => {
    const schema = zodObjectToStrictJsonSchema(
      z.object({ v: z.string().nullable().optional() }),
    );
    expect(schema['properties']).toEqual({ v: { type: ['string', 'null'] } });
  });

  it('keeps a description attached to the outer optional wrapper', () => {
    const schema = zodObjectToStrictJsonSchema(
      z.object({ v: z.string().optional().describe('Outer.') }),
    );
    expect(schema['properties']).toEqual({
      v: { type: ['string', 'null'], description: 'Outer.' },
    });
  });

  it('throws on Zod types outside the supported subset', () => {
    expect(() =>
      zodObjectToStrictJsonSchema(z.object({ v: z.record(z.string()) })),
    ).toThrow(/unsupported Zod type/);
    expect(() =>
      zodObjectToStrictJsonSchema(
        z.object({ v: z.union([z.string(), z.number()]) }),
      ),
    ).toThrow(/unsupported Zod type/);
  });

  it('converts every registered tool spec without throwing', () => {
    for (const spec of Object.values(AI_TOOL_SPECS)) {
      expect(() => toOpenAiToolDef(spec)).not.toThrow();
    }
  });
});
