import { BREEZE_SOURCE_ENDPOINTS } from './breeze.schemas.js';
import type { PresencePlan, ShapeNode } from './breeze-field-presence.js';
import {
  ZodSourceReader,
  compareBreezeContract,
  expectedBreezeContract,
  findEnvelopeName,
  formatContractReport,
  type BreezeSourceFiles,
  type ContractReport,
} from './breeze-upstream-contract.js';

const BASE_KEYS = ['id', 'orgId', 'siteId', 'sourceUpdatedAt', 'revision'];
const VERSION_INFO = `export function getVersionInfo(): { version: string; binariesVersion: string } {
  return { version: API_VERSION, binariesVersion: getBinariesVersion() };
}`;

function camel(endpoint: string): string {
  return endpoint.replace(/-([a-z])/gu, (_m, c: string) => c.toUpperCase());
}

/** Breeze-style Zod source for a shape: nested objects, lists, scalars. */
function renderShape(shape: ShapeNode, variant?: { key: string; value: string }): string {
  const fields: string[] = [];
  for (const [key, entry] of shape) {
    let value: string;
    if (variant && key === variant.key) value = `z.literal('${variant.value}')`;
    else if (entry.array) {
      value = entry.child
        ? `z.array(z.object({ ${renderShape(entry.child)} }).strict()).max(500)`
        : 'z.array(z.string().max(1000)).max(500)';
    } else if (entry.child) value = `z.object({ ${renderShape(entry.child)} }).strict().nullable()`;
    else value = 'z.string().max(1000).nullable()';
    fields.push(`${key}: ${value}`);
  }
  return fields.join(', ');
}

function recordShape(shape: ShapeNode): ShapeNode {
  return new Map([...shape].filter(([key]) => !BASE_KEYS.includes(key)));
}

function renderRecord(name: string, plan: PresencePlan): string {
  if (plan.discriminator === null) {
    return `export const ${name}RecordSchema = strictRecordSchema({ ${renderShape(recordShape(plan.shapes.get('')!))} });`;
  }
  const options: string[] = [];
  const lines: string[] = [];
  for (const [variant, shape] of plan.shapes) {
    const option = `${name}_${variant}`;
    options.push(option);
    lines.push(
      `const ${option} = createRecordSchema({ ${renderShape(recordShape(shape), { key: plan.discriminator, value: variant })} });`,
    );
  }
  lines.push(`export const ${name}RecordSchema = z.discriminatedUnion('${plan.discriminator}', [${options.join(', ')}]);`);
  return lines.join('\n');
}

/**
 * A Breeze-like source tree that declares exactly what Weavestream reads,
 * written the way Breeze writes it (a strict base, a helper that extends
 * it, an alias of the helper, an envelope builder function).
 */
function matchingSource(): BreezeSourceFiles {
  const expected = expectedBreezeContract();
  const lines = [
    "import { z } from 'zod';",
    'export const baseRecordSchema = z.object({',
    '  id: z.string().uuid(), orgId: z.string().uuid(), siteId: z.string().uuid().nullable(),',
    '  sourceUpdatedAt: z.string().datetime({ offset: true }), revision: z.string(),',
    '}).strict();',
    'export function strictRecordSchema<const T extends z.ZodRawShape>(shape: T) {',
    '  for (const key of Object.keys(shape)) { if (key === "id") throw new TypeError(key); }',
    '  return baseRecordSchema.extend(shape).strict();',
    '}',
    'export const createRecordSchema = strictRecordSchema;',
    `export const blockedRecordSchema = z.object({ ${renderShape(expected.blockedNotice.shapes.get('')!)} }).strict();`,
    'export function createEnvelopeSchema<T extends z.ZodType>(recordSchema: T) {',
    '  return z.object({',
    "    schemaVersion: z.literal('1'),",
    '    snapshotAt: z.string(),',
    '    data: z.array(recordSchema).max(500),',
    '    nextCursor: z.string().nullable(),',
    '    hasMore: z.boolean(),',
    '    blocked: z.array(blockedRecordSchema).max(500).optional(),',
    '  }).strict().superRefine(() => undefined);',
    '}',
  ];
  const routes: string[] = ["import * as s from './schemas';"];
  for (const endpoint of BREEZE_SOURCE_ENDPOINTS) {
    const name = camel(endpoint);
    lines.push(renderRecord(name, expected.endpoints[endpoint]));
    lines.push(`export const ${name}EnvelopeSchema = createEnvelopeSchema(${name}RecordSchema);`);
    routes.push(
      `routes.get('/${endpoint}', scope('read'), async (c) => {`,
      '  const rows = await load();',
      `  return c.json(${name}EnvelopeSchema.parse(rows));`,
      '});',
    );
  }
  return {
    schemas: lines.join('\n'),
    routes: { 'export.ts': routes.join('\n') },
    versionInfo: VERSION_INFO,
  };
}

function compare(files: BreezeSourceFiles): ContractReport {
  return compareBreezeContract(expectedBreezeContract(), files);
}

describe('Breeze upstream contract check', () => {
  it('derives what Weavestream reads from the driver schemas', () => {
    const expected = expectedBreezeContract();
    expect(expected.schemaVersion).toBe('1');
    expect(Object.keys(expected.endpoints)).toEqual([...BREEZE_SOURCE_ENDPOINTS]);
    const devices = expected.endpoints.devices.shapes.get('')!;
    expect([...devices.keys()]).toEqual(expect.arrayContaining([...BASE_KEYS, 'hostname', 'tags']));
    expect([...expected.endpoints['device-inventory'].shapes.keys()]).toEqual(['device', 'site']);
    expect([...expected.envelope.shapes.get('')!.keys()]).toEqual(
      expect.arrayContaining(['schemaVersion', 'snapshotAt', 'data', 'nextCursor', 'hasMore', 'blocked']),
    );
  });

  it('passes a release that declares everything Weavestream reads', () => {
    const report = compare(matchingSource());
    expect(report.differences).toEqual([]);
    expect(report.failed).toBe(false);
    expect(report.uncheckedFields).toBe(0);
    expect(report.checkedFields).toBeGreaterThan(300);
    expect(formatContractReport(report, 'v9.9.9')).toContain('no partner API change Weavestream depends on');
  });

  it('reports a renamed field on the endpoint that reads it', () => {
    const files = matchingSource();
    files.schemas = files.schemas.replace('hostname:', 'hostName:');
    const report = compare(files);
    expect(report.failed).toBe(true);
    expect(report.differences).toEqual([
      expect.objectContaining({ problem: 'field_missing', severity: 'breaking', where: 'devices', path: 'hostname' }),
    ]);
  });

  it('reports a removed nested field with its full path', () => {
    const files = matchingSource();
    // The device `type` section reads `virtualizationPlatform`.
    files.schemas = files.schemas.replace(/,? ?virtualizationPlatform: z\.string\(\)\.max\(1000\)\.nullable\(\)/u, '');
    expect(files.schemas).not.toContain('virtualizationPlatform');
    expect(compare(files).differences).toEqual([
      expect.objectContaining({ where: 'devices', path: 'type.virtualizationPlatform' }),
    ]);
  });

  it('reports a list that became a single value', () => {
    const files = matchingSource();
    files.schemas = files.schemas.replace(
      /(devicesRecordSchema = strictRecordSchema\(\{.*?tags: )z\.array\(z\.string\(\)\.max\(1000\)\)\.max\(500\)/u,
      '$1z.string()',
    );
    expect(compare(files).differences).toEqual([
      expect.objectContaining({ problem: 'not_a_list', where: 'devices', path: 'tags' }),
    ]);
  });

  it('reports a new schemaVersion once, not per endpoint', () => {
    const files = matchingSource();
    files.schemas = files.schemas.replace("schemaVersion: z.literal('1')", "schemaVersion: z.literal('2')");
    const report = compare(files);
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]).toMatchObject({ problem: 'schema_version', severity: 'breaking' });
    expect(report.differences[0]!.message).toContain('schemaVersion "2"; Weavestream knows "1"');
  });

  it('reports a removed endpoint and a removed record variant', () => {
    const files = matchingSource();
    files.routes['export.ts'] = files.routes['export.ts']!.replace("routes.get('/scripts'", "routes.post('/scripts'");
    files.schemas = files.schemas.replace(
      "z.discriminatedUnion('subjectType', [deviceInventory_device, deviceInventory_site])",
      "z.discriminatedUnion('subjectType', [deviceInventory_device])",
    );
    const report = compare(files);
    expect(report.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ problem: 'endpoint_missing', where: 'scripts' }),
      expect.objectContaining({ problem: 'variant_missing', where: 'device-inventory', path: 'subjectType=site' }),
    ]));
  });

  it('fails loudly when it cannot read an endpoint contract', () => {
    const files = matchingSource();
    files.schemas = files.schemas.replace(
      'export const sitesEnvelopeSchema = createEnvelopeSchema(sitesRecordSchema);',
      "export const sitesEnvelopeSchema = buildFromRegistry('sites');",
    );
    expect(compare(files).differences).toEqual([
      expect.objectContaining({ problem: 'contract_unreadable', where: 'sites', severity: 'breaking' }),
    ]);
  });

  it('reports a /health change as a notice that does not fail the check', () => {
    const files = matchingSource();
    files.versionInfo = null;
    const report = compare(files);
    expect(report.failed).toBe(false);
    expect(report.differences).toEqual([
      expect.objectContaining({ problem: 'health_version', severity: 'notice' }),
    ]);
    expect(formatContractReport(report, 'v9.9.9')).toContain('Version endpoint changed (notice)');
  });

  it('formats a readable summary that names each change', () => {
    const files = matchingSource();
    files.schemas = files.schemas.replace('hostname:', 'hostName:');
    const text = formatContractReport(compare(files), 'v0.200.0');
    expect(text).toContain('## Breeze v0.200.0: 1 partner API change(s) Weavestream depends on');
    expect(text).toContain('| Field removed or renamed | `devices` | devices: hostname is no longer declared (removed or renamed). Weavestream reads it. |');
    expect(text).toContain('Update the Breeze driver before customers upgrade');
  });
});

describe('ZodSourceReader', () => {
  const read = (source: string, name: string) => new ZodSourceReader(source).schemaOf(name);
  const keys = (node: ReturnType<typeof read>) =>
    node.kind === 'object' ? [...node.fields.keys()] : node.kind;

  it('follows spreads, extend, pick, omit, merge, and wrappers', () => {
    const source = `
      const common = { a: z.string(), b: z.number() };
      const base = z.object({ id: z.string() }).strict();
      export const spread = base.extend({ ...common, c: z.boolean() }).nullable();
      export const picked = spread.pick({ a: true, id: true });
      export const omitted = spread.omit({ a: true });
      export const merged = base.merge(z.object({ d: z.string() }));
      export const wrapped = (z.optional(merged) as unknown as typeof merged);
    `;
    expect(keys(read(source, 'spread'))).toEqual(['id', 'a', 'b', 'c']);
    expect(keys(read(source, 'picked'))).toEqual(['id', 'a']);
    expect(keys(read(source, 'omitted'))).toEqual(['id', 'b', 'c']);
    expect(keys(read(source, 'merged'))).toEqual(['id', 'd']);
    expect(keys(read(source, 'wrapped'))).toEqual(['id', 'd']);
  });

  it('reads one field of another schema through .shape', () => {
    const source = `
      const device = z.object({ edges: z.array(z.object({ key: z.string() })) });
      export const site = z.object({ edges: device.shape.edges, ...device.shape });
    `;
    const site = read(source, 'site');
    expect(site.kind).toBe('object');
    const edges = site.kind === 'object' ? site.fields.get('edges') : undefined;
    expect(edges?.kind).toBe('array');
  });

  it('treats imports, recursion, and unknown helpers as unknown, never as removed', () => {
    const source = `
      import { importedSchema } from './elsewhere';
      export const fromImport = importedSchema.extend({ a: z.string() });
      export const loop: z.ZodTypeAny = z.lazy(() => loop);
      export const self = z.object({ child: selfRef });
      const selfRef = self;
      export const viaHelper = unknownHelper({ a: z.string() });
    `;
    expect(read(source, 'fromImport').kind).toBe('unknown');
    expect(read(source, 'loop').kind).toBe('leaf');
    const self = read(source, 'self');
    expect(self.kind === 'object' && self.fields.get('child')?.kind).toBe('unknown');
    expect(read(source, 'viaHelper').kind).toBe('unknown');
    expect(read(source, 'missing').kind).toBe('unknown');
  });

  it('does not run the source it reads', () => {
    const marker = '__breezeContractCheckRan';
    const source = `
      (globalThis as Record<string, unknown>)['${marker}'] = true;
      export const value = z.object({ a: z.string() });
    `;
    read(source, 'value');
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });
});

describe('findEnvelopeName', () => {
  it('takes the first envelope named in the route body, up to the next route', () => {
    const routes = {
      'a.ts': [
        "r.get('/devices', auth, async (c) => {",
        '  if (none) return c.json(deviceExportEnvelopeSchema.parse(empty));',
        '  return c.json(deviceExportEnvelopeSchema.parse(page));',
        '});',
        "r.get('/sites', auth, (c) => exportResource(c, 'sites', siteExportEnvelopeSchema));",
      ].join('\n'),
    };
    expect(findEnvelopeName(routes, 'devices')).toEqual({ found: true, envelope: 'deviceExportEnvelopeSchema' });
    expect(findEnvelopeName(routes, 'sites')).toEqual({ found: true, envelope: 'siteExportEnvelopeSchema' });
    expect(findEnvelopeName(routes, 'scripts')).toEqual({ found: false, envelope: null });
    // A route path is matched exactly, not as a prefix.
    expect(findEnvelopeName(routes, 'device')).toEqual({ found: false, envelope: null });
  });
});
