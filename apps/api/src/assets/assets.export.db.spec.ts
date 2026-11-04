import { ASSET_EXPORT_MAX_ROWS } from '@weavestream/shared';
import { AssetsService } from './assets.service.js';
import { TagsService } from '../tags/tags.service.js';
import { SearchIndexService } from '../search/search-index.service.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { AssetExportOptions } from './assets.service.js';
import { FULL_PASSWORD_ACCESS } from '../passwords/password-access-policy.js';

/**
 * DB-backed proof of the per-layout CSV export: tenant scope, the same
 * rows as the list (search, archive toggle, tag filter after the row
 * cap), the column modes, the excluded and hidden fields, cell
 * formatting, formula neutralization, and the audit row.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1`, for the same
 * reason as `assets.search.db.spec.ts`: without the flag this spec
 * would write to the configured development database. Every row it
 * writes uses the ids below and is removed in `afterAll`. Run with:
 *   WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @weavestream/api test assets.export.db
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const id = (suffix: string) => `3fc00000-0000-4000-8000-${suffix.padStart(12, '0')}`;

const COMPANY = id('c001');
const OTHER_COMPANY = id('c002');
const DEVICES = id('d001');
const BULK = id('d002');

const F = {
  hostname: id('f001'),
  serial: id('f002'),
  count: id('f003'),
  managed: id('f004'),
  vault: id('f005'),
  links: id('f006'),
  tags: id('f007'),
  docs: id('f008'),
  notes: id('f009'),
  internal: id('f010'),
  bulkName: id('f101'),
  bulkTags: id('f102'),
};

const A = {
  alpha: id('b001'),
  bravo: id('b002'),
  charlie: id('b003'),
  other: id('b004'),
};

const TAG = id('e001');
const UPLOAD = id('e101');

function actor(role: 'OPERATOR' | 'CLIENT_USER'): AuthedUser {
  return {
    id: id(role === 'OPERATOR' ? 'a001' : 'a002'),
    email: `asset-export-spec-${role.toLowerCase()}@example.com`,
    role,
    globalAccess: role === 'OPERATOR' ? 'FULL' : 'NONE',
    platformCapabilities: [],
    sessionId: id('e002'),
    mfaEnforcementCompletedAt: null,
    mfaPending: false,
    passwordAccess: FULL_PASSWORD_ACCESS,
  } as AuthedUser;
}

const OPERATOR = actor('OPERATOR');
const CLIENT = actor('CLIENT_USER');
const META = { ip: '203.0.113.1', userAgent: 'jest' };

/** Every cell is quoted, and no test value holds a line break. */
function parseCsv(csv: string): string[][] {
  expect(csv.startsWith('﻿')).toBe(true);
  return csv
    .slice(1)
    .split('\r\n')
    .filter((line) => line.length > 0)
    .map((line) => Array.from(line.matchAll(/"((?:[^"]|"")*)"/g), (m) => m[1]!.replace(/""/g, '"')));
}

describeIfDb('assets CSV export (DB integration)', () => {
  const prisma = new PrismaService();
  const registry = new FieldTypesRegistry();
  const audit = { log: jest.fn(async () => undefined) };
  const searchIndex = new SearchIndexService(prisma, registry);
  const tags = new TagsService(prisma, audit as never, searchIndex);
  const uploads = {
    // Hydrated FILE entries carry URLs; the export must drop them.
    hydrateFileFieldEntries: async (_companyId: string, entries: Array<Record<string, unknown>>) =>
      entries.map((e) => ({
        ...e,
        thumbnailUrl: null,
        downloadUrl: `/api/v1/uploads/${String(e.uploadId)}/download`,
      })),
  };
  const assets = new AssetsService(
    prisma,
    audit as never,
    registry,
    {} as never,
    uploads as never,
    searchIndex,
    {} as never,
    { isStarred: async () => false } as never,
    tags,
  );

  async function exportRows(
    options: Partial<AssetExportOptions> = {},
    who: AuthedUser = OPERATOR,
    companyId = COMPANY,
  ) {
    const result = await assets.exportCsv(
      who,
      companyId,
      { layoutId: DEVICES, columns: 'table', ...options },
      META,
    );
    const [header, ...rows] = parseCsv(result.csv);
    return { ...result, header: header!, rows };
  }

  async function cleanup() {
    await prisma.asset.deleteMany({ where: { companyId: { in: [COMPANY, OTHER_COMPANY] } } });
    await prisma.assetField.deleteMany({ where: { assetLayoutId: { in: [DEVICES, BULK] } } });
    await prisma.assetLayout.deleteMany({ where: { id: { in: [DEVICES, BULK] } } });
    await prisma.company.deleteMany({ where: { id: { in: [COMPANY, OTHER_COMPANY] } } });
    await prisma.tag.deleteMany({ where: { id: TAG } });
  }

  beforeAll(async () => {
    await prisma.$connect();
    await cleanup();
    await prisma.company.createMany({
      data: [
        { id: COMPANY, name: 'Asset Export Spec Co', slug: 'asset-export-spec' },
        { id: OTHER_COMPANY, name: 'Asset Export Spec Other Co', slug: 'asset-export-spec-other' },
      ],
    });
    await prisma.tag.create({ data: { id: TAG, name: 'Exportspec', nameLower: 'exportspec' } });
    await prisma.assetLayout.create({
      data: {
        id: DEVICES,
        name: 'Asset Export Spec Devices',
        slug: 'asset-export-spec-devices',
        icon: 'laptop',
        color: '#0d7d72',
        fields: {
          create: [
            { id: F.hostname, name: 'Hostname', slug: 'hostname', fieldType: 'TEXT', position: 0, isPrimary: true, showInTable: true },
            { id: F.serial, name: 'Serial', slug: 'serial', fieldType: 'TEXT', position: 1, showInTable: true },
            { id: F.count, name: 'Count', slug: 'count', fieldType: 'NUMBER', position: 2, showInTable: true },
            { id: F.managed, name: 'Managed', slug: 'managed', fieldType: 'BOOLEAN', position: 3, showInTable: true },
            { id: F.vault, name: 'Vault', slug: 'vault', fieldType: 'VAULTWARDEN_LINK', position: 4, showInTable: true },
            { id: F.links, name: 'Links', slug: 'links', fieldType: 'ASSET_REFERENCE', position: 5, showInTable: true },
            { id: F.tags, name: 'Tags', slug: 'tags', fieldType: 'TAGS', position: 6 },
            { id: F.docs, name: 'Docs', slug: 'docs', fieldType: 'FILE', position: 7 },
            { id: F.notes, name: 'Notes', slug: 'notes', fieldType: 'RICH_TEXT', position: 8 },
            {
              id: F.internal,
              name: 'Internal',
              slug: 'internal',
              fieldType: 'TEXT',
              position: 9,
              visibleToClients: false,
            },
          ],
        },
      },
    });
    await prisma.assetLayout.create({
      data: {
        id: BULK,
        name: 'Asset Export Spec Bulk',
        slug: 'asset-export-spec-bulk',
        icon: 'box',
        color: '#0d7d72',
        fields: {
          create: [
            { id: F.bulkName, name: 'Name', slug: 'name', fieldType: 'TEXT', position: 0, isPrimary: true },
            { id: F.bulkTags, name: 'Tags', slug: 'tags', fieldType: 'TAGS', position: 1 },
          ],
        },
      },
    });
    await prisma.asset.createMany({
      data: [
        { id: A.alpha, companyId: COMPANY, assetLayoutId: DEVICES, name: 'Alpha' },
        { id: A.bravo, companyId: COMPANY, assetLayoutId: DEVICES, name: 'Bravo' },
        {
          id: A.charlie,
          companyId: COMPANY,
          assetLayoutId: DEVICES,
          name: 'Charlie',
          archivedAt: new Date('2026-01-02T03:04:05Z'),
        },
        { id: A.other, companyId: OTHER_COMPANY, assetLayoutId: DEVICES, name: 'Alpha other' },
      ],
    });
    const v = (assetId: string, assetFieldId: string, value: unknown, companyId = COMPANY) => ({
      companyId,
      assetId,
      assetFieldId,
      value: value as never,
    });
    await prisma.assetFieldValue.createMany({
      data: [
        v(A.alpha, F.serial, '=HYPERLINK("http://example.test","x")'),
        v(A.alpha, F.count, 0),
        v(A.alpha, F.managed, false),
        v(A.alpha, F.vault, { url: 'https://vault.example.test/item/1', label: 'Vault item' }),
        // Multiple references; the other company's asset is unresolvable here.
        v(A.alpha, F.links, [A.bravo, A.other]),
        v(A.alpha, F.tags, [TAG]),
        v(A.alpha, F.docs, [{ uploadId: UPLOAD, filename: 'invoice-778.pdf' }]),
        v(A.alpha, F.notes, { v: null, plain: 'Rack four, top shelf' }),
        v(A.alpha, F.internal, 'internal-only-4471'),
        v(A.bravo, F.serial, null),
        v(A.bravo, F.links, [A.alpha]),
        v(A.charlie, F.links, []),
        v(A.other, F.serial, 'OTHER-SERIAL', OTHER_COMPANY),
      ],
    });
    await searchIndex.reindexLayout(DEVICES);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(() => audit.log.mockClear());

  it('exports the table columns in table mode, without the Vaultwarden column', async () => {
    const { header, rows, filename } = await exportRows();
    expect(header).toEqual(['Name', 'Serial', 'Count', 'Managed', 'Links', 'Updated']);
    expect(rows.map((r) => r[0])).toEqual(['Alpha', 'Bravo']);
    expect(filename).toMatch(/^asset-export-spec-asset-export-spec-devices-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('exports every visible field in all mode, still without the Vaultwarden column', async () => {
    const { header, rows } = await exportRows({ columns: 'all' });
    expect(header).toEqual([
      'Name',
      'Serial',
      'Count',
      'Managed',
      'Links',
      'Tags',
      'Docs',
      'Notes',
      'Internal',
      'ID',
      'Created',
      'Updated',
      'Archived at',
    ]);
    const alpha = rows.find((r) => r[0] === 'Alpha')!;
    expect(alpha.join('|')).not.toContain('vault.example.test');
    expect(alpha.join('|')).not.toContain('[object Object]');
    expect(alpha[5]).toBe('Exportspec');
    expect(alpha[6]).toBe('invoice-778.pdf');
    expect(alpha.join('|')).not.toContain('/api/v1/uploads');
    expect(alpha[7]).toBe('Rack four, top shelf');
    expect(alpha[8]).toBe('internal-only-4471');
    expect(alpha[9]).toBe(A.alpha);
  });

  it('neutralizes a formula and keeps 0 and false', async () => {
    const { rows } = await exportRows();
    const alpha = rows.find((r) => r[0] === 'Alpha')!;
    expect(alpha[1]).toBe(`'=HYPERLINK("http://example.test","x")`);
    expect(alpha[2]).toBe('0');
    expect(alpha[3]).toBe('no');
  });

  it('exports absent values and explicit nulls as empty cells', async () => {
    const { rows } = await exportRows();
    const bravo = rows.find((r) => r[0] === 'Bravo')!;
    expect(bravo[1]).toBe(''); // explicit null
    expect(bravo[2]).toBe(''); // absent
    expect(bravo[3]).toBe(''); // absent boolean
  });

  it('resolves single, multiple, empty, and unresolved references', async () => {
    const { rows } = await exportRows({ includeArchived: true });
    const byName = new Map(rows.map((r) => [r[0], r]));
    expect(byName.get('Alpha')![4]).toBe(`Bravo, ${A.other}`);
    expect(byName.get('Bravo')![4]).toBe('Alpha');
    expect(byName.get('Charlie')![4]).toBe('');
  });

  it('follows the archive toggle and adds the Archived at column', async () => {
    const { header, rows } = await exportRows({ includeArchived: true });
    expect(header.at(-1)).toBe('Archived at');
    // The list's order: `archivedAt ASC` puts NULLs last in Postgres.
    const list = await assets.list(OPERATOR, COMPANY, {
      layoutId: DEVICES,
      includeArchived: true,
      limit: 200,
    });
    expect(rows.map((r) => r[0])).toEqual(list.items.map((a) => a.name));
    expect(rows.map((r) => r[0])).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(rows[0]!.at(-1)).toBe('2026-01-02T03:04:05.000Z');
    expect(rows[1]!.at(-1)).toBe('');
  });

  it('returns the same rows as the list for a search', async () => {
    const list = await assets.list(OPERATOR, COMPANY, { layoutId: DEVICES, q: 'bravo', limit: 200 });
    const { rows } = await exportRows({ q: 'bravo' });
    expect(rows.map((r) => r[0])).toEqual(list.items.map((a) => a.name));
    expect(rows.map((r) => r[0])).toEqual(['Bravo']);
  });

  it('applies the tag filter', async () => {
    const { rows } = await exportRows({ tagId: TAG });
    expect(rows.map((r) => r[0])).toEqual(['Alpha']);
  });

  it('never exports another company’s asset', async () => {
    const { rows } = await exportRows({}, OPERATOR, OTHER_COMPANY);
    expect(rows.map((r) => r[0])).toEqual(['Alpha other']);
    const own = await exportRows({ columns: 'all' });
    expect(own.csv).not.toContain('OTHER-SERIAL');
  });

  it('keeps fields hidden from clients out of a client export', async () => {
    const { header, csv } = await exportRows({ columns: 'all' }, CLIENT);
    expect(header).not.toContain('Internal');
    expect(csv).not.toContain('internal-only-4471');
  });

  it('writes one asset.export audit row with counts and no cell values', async () => {
    await exportRows({ columns: 'all', q: 'alpha', tagId: TAG });
    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = (audit.log.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      actorId: OPERATOR.id,
      action: 'asset.export',
      entityType: 'AssetLayout',
      entityId: DEVICES,
      companyId: COMPANY,
      ip: META.ip,
      userAgent: META.userAgent,
      after: {
        columns: 'all',
        fieldSlugs: ['serial', 'count', 'managed', 'links', 'tags', 'docs', 'notes', 'internal'],
        rowCount: 1,
        truncated: false,
        filters: { searchTermCount: 1, includeArchived: false, tagId: TAG },
      },
    });
    expect(JSON.stringify(entry)).not.toContain('HYPERLINK');
    expect(JSON.stringify(entry)).not.toContain('alpha');
  });

  describe('row cap', () => {
    const LAST = ASSET_EXPORT_MAX_ROWS + 1;
    const bulkId = (n: number) => `3fc00000-0000-4000-9000-${String(n).padStart(12, '0')}`;
    const bulkName = (n: number) => `Bulk ${String(n).padStart(5, '0')}`;

    beforeAll(async () => {
      await prisma.asset.createMany({
        data: Array.from({ length: LAST }, (_, i) => ({
          id: bulkId(i + 1),
          companyId: COMPANY,
          assetLayoutId: BULK,
          name: bulkName(i + 1),
        })),
      });
      // Tagged: the first row (inside the cap) and the last (past it).
      await prisma.assetFieldValue.createMany({
        data: [1, LAST].map((n) => ({
          companyId: COMPANY,
          assetId: bulkId(n),
          assetFieldId: F.bulkTags,
          value: [TAG] as never,
        })),
      });
    });

    it('caps the base list and reports truncated', async () => {
      const { rows, truncated, rowCount } = await exportRows({ layoutId: BULK });
      expect(truncated).toBe(true);
      expect(rowCount).toBe(ASSET_EXPORT_MAX_ROWS);
      expect(rows).toHaveLength(ASSET_EXPORT_MAX_ROWS);
      expect(rows.at(-1)![0]).toBe(bulkName(ASSET_EXPORT_MAX_ROWS));
    });

    it('filters by tag after the cap, like the table', async () => {
      const { rows, truncated } = await exportRows({ layoutId: BULK, tagId: TAG });
      expect(rows.map((r) => r[0])).toEqual([bulkName(1)]);
      expect(truncated).toBe(true);
    });
  });
});
