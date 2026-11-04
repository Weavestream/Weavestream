import { AssetsService } from './assets.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * DB-backed proof of the `field.<slug>=<value>` asset list filter
 * (discussion #99). The match runs as raw SQL over JSON values, so only
 * a real Postgres can show it finds the right rows.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1`, for the same
 * reason as `assets.pagination.db.spec.ts`: without the flag this spec
 * would write to the configured development database. Run locally with:
 *   WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @weavestream/api test assets.field-filters.db
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const id = (suffix: string) => `3fa00000-0000-4000-8000-${suffix.padStart(12, '0')}`;

const COMPANY = id('c001');
const OTHER_COMPANY = id('c002');
const LAPTOPS = id('d001');
const SERVERS = id('d002');

const F = {
  laptopMaker: id('f001'),
  vendor: id('f002'),
  laptopRam: id('f003'),
  managed: id('f004'),
  serverMaker: id('f011'),
  serverRam: id('f012'),
};

const A = {
  dellLaptop: id('b001'),
  lenovoLaptop: id('b002'),
  dellServer: id('b003'),
  otherCompanyDell: id('b004'),
};

const OPERATOR: AuthedUser = {
  id: id('a001'),
  email: 'asset-field-filter-spec@example.com',
  role: 'OPERATOR',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: id('e001'),
  mfaEnforcementCompletedAt: null,
  mfaPending: false,
  globalPasswordAccess: true,
};

describeIfDb('assets list field filters (DB integration)', () => {
  const prisma = new PrismaService();
  // list() touches only prisma here: no filter field is primary or a
  // table column, so the list projection loads no values to hydrate.
  const service = new AssetsService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { isStarred: async () => false } as never,
    { getMany: async () => new Map() } as never,
  );

  async function ids(options: Parameters<AssetsService['list']>[2], companyId = COMPANY) {
    const page = await service.list(OPERATOR, companyId, { limit: 50, ...options });
    return page.items.map((a) => a.id).sort();
  }

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.company.createMany({
      data: [
        { id: COMPANY, name: 'Field Filter Spec Co', slug: 'field-filter-spec' },
        { id: OTHER_COMPANY, name: 'Field Filter Spec Other Co', slug: 'field-filter-spec-other' },
      ],
    });
    await prisma.assetLayout.create({
      data: {
        id: LAPTOPS,
        name: 'Field Filter Spec Laptops',
        slug: 'field-filter-spec-laptops',
        icon: 'laptop',
        color: '#0d7d72',
        fields: {
          create: [
            { id: F.laptopMaker, name: 'Manufacturer', slug: 'manufacturer', fieldType: 'TEXT', position: 0 },
            {
              id: F.vendor,
              name: 'Vendor',
              slug: 'vendor',
              fieldType: 'DROPDOWN',
              position: 1,
              options: { choices: [{ slug: 'dell', label: 'Dell Technologies' }] },
            },
            { id: F.laptopRam, name: 'RAM', slug: 'ram', fieldType: 'NUMBER', position: 2 },
            { id: F.managed, name: 'Managed', slug: 'managed', fieldType: 'BOOLEAN', position: 3 },
          ],
        },
      },
    });
    await prisma.assetLayout.create({
      data: {
        id: SERVERS,
        name: 'Field Filter Spec Servers',
        slug: 'field-filter-spec-servers',
        icon: 'dns',
        color: '#0d7d72',
        fields: {
          create: [
            { id: F.serverMaker, name: 'Manufacturer', slug: 'manufacturer', fieldType: 'TEXT', position: 0 },
            { id: F.serverRam, name: 'RAM', slug: 'ram', fieldType: 'TEXT', position: 1 },
          ],
        },
      },
    });
    await prisma.asset.createMany({
      data: [
        { id: A.dellLaptop, companyId: COMPANY, assetLayoutId: LAPTOPS, name: 'Dell laptop' },
        { id: A.lenovoLaptop, companyId: COMPANY, assetLayoutId: LAPTOPS, name: 'Lenovo laptop' },
        { id: A.dellServer, companyId: COMPANY, assetLayoutId: SERVERS, name: 'Dell server' },
        { id: A.otherCompanyDell, companyId: OTHER_COMPANY, assetLayoutId: LAPTOPS, name: 'Other Dell' },
      ],
    });
    const v = (companyId: string, assetId: string, assetFieldId: string, value: unknown) => ({
      companyId,
      assetId,
      assetFieldId,
      value: value as never,
    });
    await prisma.assetFieldValue.createMany({
      data: [
        v(COMPANY, A.dellLaptop, F.laptopMaker, 'Dell'),
        v(COMPANY, A.dellLaptop, F.vendor, 'dell'),
        v(COMPANY, A.dellLaptop, F.laptopRam, 16),
        v(COMPANY, A.dellLaptop, F.managed, true),
        v(COMPANY, A.lenovoLaptop, F.laptopMaker, 'Lenovo'),
        v(COMPANY, A.lenovoLaptop, F.managed, false),
        v(COMPANY, A.dellServer, F.serverMaker, ' DELL '),
        v(COMPANY, A.dellServer, F.serverRam, 'sixteen'),
        v(OTHER_COMPANY, A.otherCompanyDell, F.laptopMaker, 'Dell'),
      ],
    });
  });

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { companyId: { in: [COMPANY, OTHER_COMPANY] } } });
    await prisma.assetField.deleteMany({ where: { assetLayoutId: { in: [LAPTOPS, SERVERS] } } });
    await prisma.assetLayout.deleteMany({ where: { id: { in: [LAPTOPS, SERVERS] } } });
    await prisma.company.deleteMany({ where: { id: { in: [COMPANY, OTHER_COMPANY] } } });
    await prisma.$disconnect();
  });

  it('matches a shared slug on every layout, case-insensitive and trimmed', async () => {
    expect(await ids({ fieldFilters: { manufacturer: 'dell' } })).toEqual(
      [A.dellLaptop, A.dellServer].sort(),
    );
  });

  it('keeps to one layout when a layout is selected', async () => {
    expect(await ids({ layoutId: LAPTOPS, fieldFilters: { manufacturer: 'DELL' } })).toEqual([
      A.dellLaptop,
    ]);
  });

  it('never returns another company’s asset with the same value', async () => {
    expect(await ids({ fieldFilters: { manufacturer: 'dell' } }, OTHER_COMPANY)).toEqual([
      A.otherCompanyDell,
    ]);
  });

  it('matches a dropdown by its label or its slug', async () => {
    expect(await ids({ fieldFilters: { vendor: 'Dell Technologies' } })).toEqual([A.dellLaptop]);
    expect(await ids({ fieldFilters: { vendor: 'DELL' } })).toEqual([A.dellLaptop]);
  });

  it('matches NUMBER and BOOLEAN values, and uses the other layout for a non-number', async () => {
    expect(await ids({ fieldFilters: { ram: '16' } })).toEqual([A.dellLaptop]);
    expect(await ids({ fieldFilters: { ram: '16.0' } })).toEqual([A.dellLaptop]);
    expect(await ids({ fieldFilters: { ram: 'Sixteen' } })).toEqual([A.dellServer]);
    expect(await ids({ fieldFilters: { managed: 'false' } })).toEqual([A.lenovoLaptop]);
  });

  it('ANDs several filters', async () => {
    expect(await ids({ fieldFilters: { manufacturer: 'dell', managed: 'true' } })).toEqual([
      A.dellLaptop,
    ]);
    expect(await ids({ fieldFilters: { manufacturer: 'lenovo', managed: 'true' } })).toEqual([]);
  });
});
