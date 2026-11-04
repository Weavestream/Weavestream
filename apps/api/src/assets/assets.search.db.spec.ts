import { AssetsService } from './assets.service.js';
import { AssetLayoutsService } from '../asset-layouts/asset-layouts.service.js';
import { TagsService } from '../tags/tags.service.js';
import { SearchIndexService } from '../search/search-index.service.js';
import { FieldTypesRegistry } from '../field-types/field-types.registry.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * DB-backed proof of the asset list `q` search: every word must be in
 * the asset name or in any indexed field value (`search_index`), and
 * `%`/`_` match literally. Also covers the index freshness paths it
 * depends on (choice relabel, tag rename, backfill, legacy tag values)
 * and the per-asset row lock that keeps a slow backfill from writing
 * hidden field text back into `body_public`.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1`, for the same
 * reason as `assets.pagination.db.spec.ts`: without the flag this spec
 * would write to the configured development database. Every row it
 * writes uses the ids below and is removed in `afterAll`; reindexing is
 * limited to the spec's own layouts. Run locally with:
 *   WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @weavestream/api test assets.search.db
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const id = (suffix: string) => `3fb00000-0000-4000-8000-${suffix.padStart(12, '0')}`;

const COMPANY = id('c001');
const OTHER_COMPANY = id('c002');
const DEVICES = id('d001');
const HIDE = id('d002');

const F = {
  serial: id('f001'),
  assetNumber: id('f002'),
  ip: id('f003'),
  vendor: id('f004'),
  os: id('f005'),
  tags: id('f006'),
  docs: id('f007'),
  warranty: id('f008'),
  internalNote: id('f009'),
  secret: id('f101'),
};

const A = {
  laptop: id('b001'),
  underscore: id('b002'),
  lookalike: id('b003'),
  percent: id('b004'),
  legacyTags: id('b005'),
  unindexed: id('b006'),
  unindexedLookalike: id('b007'),
  other: id('b008'),
  hidden: id('b101'),
};

const TAG = id('e001');
const UPLOAD = id('e101');

function actor(role: 'OPERATOR' | 'CLIENT_USER'): AuthedUser {
  return {
    id: id(role === 'OPERATOR' ? 'a001' : 'a002'),
    email: `asset-search-spec-${role.toLowerCase()}@example.com`,
    role,
    globalAccess: role === 'OPERATOR' ? 'FULL' : 'NONE',
    platformCapabilities: [],
    sessionId: id('e002'),
    mfaEnforcementCompletedAt: null,
    mfaPending: false,
    globalPasswordAccess: true,
  } as AuthedUser;
}

const OPERATOR = actor('OPERATOR');
const CLIENT = actor('CLIENT_USER');
const META = { ip: '203.0.113.1', userAgent: 'jest' };

describeIfDb('assets list q search (DB integration)', () => {
  const prisma = new PrismaService();
  const registry = new FieldTypesRegistry();
  const audit = { log: async () => undefined };
  const searchIndex = new SearchIndexService(prisma, registry);
  const assets = new AssetsService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    searchIndex,
    {} as never,
    { isStarred: async () => false } as never,
    { getMany: async () => new Map() } as never,
  );
  const tags = new TagsService(prisma, audit as never, searchIndex);

  async function ids(
    q: string,
    options: Parameters<AssetsService['list']>[2] = {},
    who: AuthedUser = OPERATOR,
    companyId = COMPANY,
  ) {
    const page = await assets.list(who, companyId, { limit: 50, ...options, q });
    return page.items.map((a) => a.id).sort();
  }

  /** The current input for `saveFields`, from the stored field rows. */
  async function fieldsInput(layoutId: string) {
    const rows = await prisma.assetField.findMany({
      where: { assetLayoutId: layoutId, archivedAt: null },
      orderBy: { position: 'asc' },
    });
    return rows.map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      fieldType: f.fieldType,
      isRequired: f.isRequired,
      isUniquePerCompany: f.isUniquePerCompany,
      visibleToClients: f.visibleToClients,
      isPrimary: f.isPrimary,
      showInTable: f.showInTable,
      options: (f.options ?? {}) as Record<string, unknown>,
    }));
  }

  async function cleanup() {
    await prisma.asset.deleteMany({ where: { companyId: { in: [COMPANY, OTHER_COMPANY] } } });
    await prisma.assetField.deleteMany({ where: { assetLayoutId: { in: [DEVICES, HIDE] } } });
    await prisma.assetLayout.deleteMany({ where: { id: { in: [DEVICES, HIDE] } } });
    await prisma.company.deleteMany({ where: { id: { in: [COMPANY, OTHER_COMPANY] } } });
    await prisma.tag.deleteMany({ where: { id: TAG } });
  }

  beforeAll(async () => {
    await prisma.$connect();
    await cleanup();
    await prisma.company.createMany({
      data: [
        { id: COMPANY, name: 'Asset Search Spec Co', slug: 'asset-search-spec' },
        { id: OTHER_COMPANY, name: 'Asset Search Spec Other Co', slug: 'asset-search-spec-other' },
      ],
    });
    await prisma.tag.create({ data: { id: TAG, name: 'Corenetspec', nameLower: 'corenetspec' } });
    await prisma.assetLayout.create({
      data: {
        id: DEVICES,
        name: 'Asset Search Spec Devices',
        slug: 'asset-search-spec-devices',
        icon: 'laptop',
        color: '#0d7d72',
        fields: {
          create: [
            { id: F.serial, name: 'Serial', slug: 'serial', fieldType: 'TEXT', position: 0 },
            { id: F.assetNumber, name: 'Asset number', slug: 'asset_number', fieldType: 'NUMBER', position: 1 },
            { id: F.ip, name: 'IP', slug: 'ip', fieldType: 'IP_ADDRESS', position: 2 },
            {
              id: F.vendor,
              name: 'Vendor',
              slug: 'vendor',
              fieldType: 'DROPDOWN',
              position: 3,
              options: { choices: [{ slug: 'contoso', label: 'Contoso' }], allowOther: false },
            },
            {
              id: F.os,
              name: 'OS',
              slug: 'os',
              fieldType: 'MULTISELECT',
              position: 4,
              options: { choices: [{ slug: 'win11', label: 'Windows Eleven' }] },
            },
            { id: F.tags, name: 'Tags', slug: 'tags', fieldType: 'TAGS', position: 5 },
            { id: F.docs, name: 'Docs', slug: 'docs', fieldType: 'FILE', position: 6 },
            { id: F.warranty, name: 'Warranty', slug: 'warranty', fieldType: 'DATE', position: 7 },
            {
              id: F.internalNote,
              name: 'Internal note',
              slug: 'internal_note',
              fieldType: 'TEXT',
              position: 8,
              visibleToClients: false,
            },
          ],
        },
      },
    });
    await prisma.assetLayout.create({
      data: {
        id: HIDE,
        name: 'Asset Search Spec Hide',
        slug: 'asset-search-spec-hide',
        icon: 'dns',
        color: '#0d7d72',
        fields: {
          create: [{ id: F.secret, name: 'Secret', slug: 'secret', fieldType: 'TEXT', position: 0 }],
        },
      },
    });
    await prisma.asset.createMany({
      data: [
        { id: A.laptop, companyId: COMPANY, assetLayoutId: DEVICES, name: 'Laptop one' },
        { id: A.underscore, companyId: COMPANY, assetLayoutId: DEVICES, name: 'Laptop two' },
        { id: A.lookalike, companyId: COMPANY, assetLayoutId: DEVICES, name: 'Laptop three' },
        { id: A.percent, companyId: COMPANY, assetLayoutId: DEVICES, name: 'Uptime box' },
        { id: A.legacyTags, companyId: COMPANY, assetLayoutId: DEVICES, name: 'Legacy tagged' },
        { id: A.unindexed, companyId: COMPANY, assetLayoutId: DEVICES, name: 'Zebra_Printer' },
        { id: A.unindexedLookalike, companyId: COMPANY, assetLayoutId: DEVICES, name: 'ZebraXPrinter' },
        { id: A.other, companyId: OTHER_COMPANY, assetLayoutId: DEVICES, name: 'Other laptop' },
        { id: A.hidden, companyId: COMPANY, assetLayoutId: HIDE, name: 'Hide target' },
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
        v(A.laptop, F.serial, '5CD1234XYZ'),
        v(A.laptop, F.assetNumber, 1234567),
        v(A.laptop, F.ip, '10.0.4.17'),
        v(A.laptop, F.vendor, 'contoso'),
        v(A.laptop, F.os, ['win11']),
        v(A.laptop, F.tags, ['production', TAG]),
        v(A.laptop, F.docs, [{ uploadId: UPLOAD, filename: 'invoice-778.pdf' }]),
        v(A.laptop, F.warranty, '2026-03-14'),
        v(A.laptop, F.internalNote, 'hidden-pin-4471'),
        v(A.underscore, F.serial, 'ABC_123'),
        v(A.lookalike, F.serial, 'ABCX123'),
        v(A.percent, F.serial, '100% uptime'),
        v(A.legacyTags, F.tags, ['production']),
        v(A.other, F.serial, '5CD1234XYZ', OTHER_COMPANY),
        v(A.hidden, F.secret, 'SECRET-123'),
      ],
    });
    // Also proves the legacy-only and mixed TAGS values do not abort a
    // layout-wide rebuild (a non-UUID id would raise P2023).
    await expect(searchIndex.reindexLayout(DEVICES)).resolves.toBe(8);
    await searchIndex.rebuildAsset(A.hidden, COMPANY);
    // These 2 stand for assets written before the index existed.
    await prisma.searchIndex.deleteMany({
      where: { entityType: 'asset', entityId: { in: [A.unindexed, A.unindexedLookalike] } },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('finds a numeric serial in a NUMBER field, in full and in part', async () => {
    expect(await ids('1234567')).toEqual([A.laptop]);
    expect(await ids('3456')).toEqual([A.laptop]);
  });

  it('finds a text serial in full and in part, and a partial IP address', async () => {
    expect(await ids('5CD1234XYZ')).toEqual([A.laptop]);
    expect(await ids('5cd1')).toEqual([A.laptop]);
    expect(await ids('10.0.4')).toEqual([A.laptop]);
  });

  it('finds choice labels, tag names, file names and dates', async () => {
    expect(await ids('Contoso')).toEqual([A.laptop]);
    expect(await ids('windows eleven')).toEqual([A.laptop]);
    expect(await ids('corenetspec')).toEqual([A.laptop]);
    expect(await ids('invoice-778')).toEqual([A.laptop]);
    expect(await ids('2026-03')).toEqual([A.laptop]);
  });

  it('needs every word, but each word may match a different field', async () => {
    expect(await ids('contoso 5CD1')).toEqual([A.laptop]);
    expect(await ids('laptop 10.0.4')).toEqual([A.laptop]);
    expect(await ids('contoso nothing-like-this')).toEqual([]);
  });

  it('still matches the name, also for an asset with no index row', async () => {
    expect(await ids('laptop')).toEqual([A.laptop, A.underscore, A.lookalike].sort());
    expect(await ids('zebra')).toEqual([A.unindexed, A.unindexedLookalike].sort());
  });

  it('matches % and _ literally, on the index path and the name path', async () => {
    expect(await ids('ABC_123')).toEqual([A.underscore]);
    expect(await ids('100%')).toEqual([A.percent]);
    expect(await ids('%')).toEqual([A.percent]);
    expect(await ids('Zebra_P')).toEqual([A.unindexed]);
  });

  it('never returns another company’s asset with the same value', async () => {
    expect(await ids('5CD1234XYZ', {}, OPERATOR, OTHER_COMPANY)).toEqual([A.other]);
  });

  it('keeps fields hidden from clients out of a client search', async () => {
    expect(await ids('hidden-pin-4471')).toEqual([A.laptop]);
    expect(await ids('hidden-pin-4471', {}, CLIENT)).toEqual([]);
    expect(await ids('5CD1234XYZ', {}, CLIENT)).toEqual([A.laptop]);
  });

  it('combines with the layout and field filters', async () => {
    expect(await ids('laptop', { layoutId: DEVICES, fieldFilters: { serial: 'abc_123' } })).toEqual([
      A.underscore,
    ]);
    expect(await ids('laptop', { layoutId: HIDE })).toEqual([]);
  });

  it('adds no text for a legacy tag value', async () => {
    const row = await prisma.searchIndex.findUnique({
      where: { entityType_entityId: { entityType: 'asset', entityId: A.legacyTags } },
    });
    expect(row).not.toBeNull();
    expect(await ids('production')).toEqual([]);
  });

  it('backfill: a row in the old shape gets the new field text after a reindex', async () => {
    await prisma.searchIndex.update({
      where: { entityType_entityId: { entityType: 'asset', entityId: A.laptop } },
      data: { bodyInternal: '5CD1234XYZ', bodyPublic: '5CD1234XYZ' },
    });
    expect(await ids('1234567')).toEqual([]);
    await searchIndex.reindexLayout(DEVICES);
    expect(await ids('1234567')).toEqual([A.laptop]);
  });

  it('choice relabel: finds the asset by the new label and not by the old one', async () => {
    const layouts = new AssetLayoutsService(prisma, audit as never, registry, searchIndex);
    const fields = (await fieldsInput(DEVICES)).map((f) =>
      f.id === F.vendor
        ? { ...f, options: { choices: [{ slug: 'contoso', label: 'Fabrikam' }], allowOther: false } }
        : f,
    );
    await layouts.saveFields(OPERATOR, DEVICES, { fields } as never, {}, META);
    expect(await ids('fabrikam')).toEqual([A.laptop]);
    expect(await ids('contoso')).toEqual([]);
  });

  it('tag rename: finds the asset by the new name and not by the old one', async () => {
    await tags.rename(OPERATOR, TAG, 'Edgenetspec', META);
    expect(await ids('edgenetspec')).toEqual([A.laptop]);
    expect(await ids('corenetspec')).toEqual([]);
  });

  describe('hiding a field while a backfill rebuild is in flight', () => {
    /**
     * Pause `svc`'s first rebuild after its reads and before its write.
     * `resolveTagNames` runs between the asset read and the index write.
     */
    function pauseFirstRebuild(svc: SearchIndexService) {
      let reached!: () => void;
      let release!: () => void;
      const reachedP = new Promise<void>((r) => (reached = r));
      const releaseP = new Promise<void>((r) => (release = r));
      const target = svc as unknown as { resolveTagNames: (...args: unknown[]) => Promise<unknown> };
      const original = target.resolveTagNames.bind(svc);
      let first = true;
      const spy = jest.spyOn(target, 'resolveTagNames').mockImplementation(async (...args) => {
        if (first) {
          first = false;
          reached();
          await releaseP;
        }
        return original(...args);
      });
      return { reached: reachedP, release, restore: () => spy.mockRestore() };
    }

    async function setSecretVisible(visible: boolean) {
      await prisma.assetField.update({ where: { id: F.secret }, data: { visibleToClients: visible } });
      await searchIndex.rebuildAsset(A.hidden, COMPANY);
      const row = await prisma.searchIndex.findUnique({
        where: { entityType_entityId: { entityType: 'asset', entityId: A.hidden } },
      });
      expect(row!.bodyPublic.includes('SECRET-123')).toBe(visible);
    }

    async function hideSecret(svc: SearchIndexService) {
      const layouts = new AssetLayoutsService(prisma, audit as never, registry, svc);
      const fields = (await fieldsInput(HIDE)).map((f) => ({ ...f, visibleToClients: false }));
      return layouts.saveFields(OPERATOR, HIDE, { fields } as never, {}, META);
    }

    async function waitForHideCommit() {
      for (let i = 0; i < 100; i++) {
        const f = await prisma.assetField.findUnique({ where: { id: F.secret } });
        if (f && !f.visibleToClients) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('the hide never committed');
    }

    async function publicBody() {
      const row = await prisma.searchIndex.findUnique({
        where: { entityType_entityId: { entityType: 'asset', entityId: A.hidden } },
      });
      return row!.bodyPublic;
    }

    it('the row lock makes the layout reindex wait, so the hidden value stays out of body_public', async () => {
      await setSecretVisible(true);
      const backfill = new SearchIndexService(prisma, registry);
      const pause = pauseFirstRebuild(backfill);
      try {
        const rebuild = backfill.rebuildAsset(A.hidden, COMPANY);
        await pause.reached;

        let hideDone = false;
        const hide = hideSecret(searchIndex).finally(() => {
          hideDone = true;
        });
        await waitForHideCommit();
        await new Promise((r) => setTimeout(r, 300));
        expect(hideDone).toBe(false); // the layout reindex waits on the asset row lock

        pause.release();
        await Promise.all([rebuild, hide]);
      } finally {
        pause.restore();
      }
      expect(await publicBody()).not.toContain('SECRET-123');
      expect(await ids('SECRET-123', {}, CLIENT)).toEqual([]);
      expect(await ids('SECRET-123')).toEqual([A.hidden]);
    });

    it('control: without the lock the stale backfill writes the hidden value back', async () => {
      await setSecretVisible(true);
      const noLock = (svc: SearchIndexService) => {
        (svc as unknown as { lockAsset: () => Promise<void> }).lockAsset = async () => undefined;
        return svc;
      };
      const backfill = noLock(new SearchIndexService(prisma, registry));
      const reindexer = noLock(new SearchIndexService(prisma, registry));
      const pause = pauseFirstRebuild(backfill);
      try {
        const rebuild = backfill.rebuildAsset(A.hidden, COMPANY);
        await pause.reached;
        await hideSecret(reindexer); // completes: nothing makes it wait
        pause.release();
        await rebuild;
      } finally {
        pause.restore();
      }
      expect(await publicBody()).toContain('SECRET-123');
      // Leave a correct row behind.
      await searchIndex.rebuildAsset(A.hidden, COMPANY);
    });
  });
});
