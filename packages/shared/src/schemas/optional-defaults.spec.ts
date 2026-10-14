import type { z } from 'zod';
import * as schemas from './index.js';

/**
 * Zod 4 applies a `.default()` inside `.optional()` even when the key is
 * omitted; Zod 3 left the key out. On a PATCH schema that turns "not sent"
 * into "reset to the default" (it once cleared every password's tags on
 * rename). Put defaults on the outer field, or none at all, never inside
 * `.optional()`.
 */
function findOptionalDefaults(root: z.ZodType, name: string): string[] {
  const hits: string[] = [];
  const seen = new Set<unknown>();
  const visit = (schema: z.ZodType, path: string): void => {
    if (seen.has(schema)) return;
    seen.add(schema);
    const def = schema._zod.def as unknown as Record<string, unknown> & { type: string };
    const child = (key: string) => def[key] as z.ZodType;
    switch (def.type) {
      case 'optional': {
        let inner = child('innerType');
        for (;;) {
          const t = inner._zod.def.type;
          if (t === 'nullable' || t === 'readonly') {
            inner = (inner._zod.def as unknown as { innerType: z.ZodType }).innerType;
          } else if (t === 'pipe') {
            inner = (inner._zod.def as unknown as { in: z.ZodType }).in;
          } else break;
        }
        const t = inner._zod.def.type;
        if (t === 'default' || t === 'prefault') hits.push(path);
        return visit(child('innerType'), path);
      }
      case 'nullable':
      case 'readonly':
      case 'default':
      case 'prefault':
      case 'catch':
      case 'nonoptional':
        return visit(child('innerType'), path);
      case 'pipe':
        visit(child('in'), path);
        return visit(child('out'), path);
      case 'object':
        for (const [key, value] of Object.entries(def['shape'] as Record<string, z.ZodType>)) {
          visit(value, `${path}.${key}`);
        }
        return;
      case 'array':
        return visit(child('element'), `${path}[]`);
      case 'record':
        return visit(child('valueType'), `${path}{}`);
      case 'union':
        return (def['options'] as z.ZodType[]).forEach((o, i) => visit(o, `${path}|${i}`));
      case 'intersection':
        visit(child('left'), path);
        return visit(child('right'), path);
    }
  };
  visit(root, name);
  return hits;
}

describe('shared schemas', () => {
  it('never wrap a .default() inside .optional()', () => {
    const hits = Object.entries(schemas)
      .filter(([, v]) => typeof v === 'object' && v !== null && '_zod' in v)
      .flatMap(([name, v]) => findOptionalDefaults(v as z.ZodType, name));
    expect(hits).toEqual([]);
  });
});
