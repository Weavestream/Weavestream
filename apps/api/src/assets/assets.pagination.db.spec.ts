import { AssetsService } from './assets.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * DB-backed regression guard for cursor pagination over the assets
 * list (Phase 2c mobile).
 *
 * The list orders by `(archivedAt, name, id)` — `id` is the unique
 * tie-breaker Prisma cursor pagination requires. The in-memory Prisma
 * fakes used by `assets.service.spec.ts` ignore `orderBy` entirely,
 * so only a real Postgres can prove duplicate names (integration-synced
 * hardware, `Untitled <Layout>` rows) don't make pages skip or repeat
 * rows.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1` (set in CI's test
 * job, which provisions Postgres + `prisma migrate deploy`). Gating on
 * `DATABASE_URL` alone — the audit-immutability pattern — is NOT
 * sufficient here: importing `@prisma/client` loads the workspace
 * `.env`, so `DATABASE_URL` is set even in a bare local `pnpm test`,
 * and this spec would silently create/delete rows in the configured
 * *development* database. An explicit flag keeps mutation opt-in.
 * Run locally with:
 *   WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @weavestream/api test
 *
 * Deliberately NOT tested: stability when the cursor row's name is
 * renamed between pages. That is an accepted weakness of cursoring
 * over a mutable, user-visible alphabetical order (see the orderBy
 * comment in `assets.service.ts`).
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const COMPANY = '2ca00000-0000-4000-8000-00000000c001';
const LAYOUT = '2ca00000-0000-4000-8000-00000000d001';

const OPERATOR: AuthedUser = {
  id: '2ca00000-0000-4000-8000-00000000a001',
  email: 'asset-pagination-spec@example.com',
  role: 'OPERATOR',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: '2ca00000-0000-4000-8000-00000000e001',
  mfaEnforcementCompletedAt: null,
  mfaPending: false,
};

describeIfDb('assets list cursor pagination (DB integration)', () => {
  const prisma = new PrismaService();
  // list() touches only prisma: with a TEXT-only layout and no field
  // values, every hydrator (file/reference/tag/sync/actor) either
  // short-circuits or queries prisma directly, so the write-path
  // collaborators are never reached.
  const service = new AssetsService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // stars + tags are reached by the Phase-4 projection test's
    // `get()` call and by tag hydration; minimal read-only stubs.
    { isStarred: async () => false } as never,
    { getMany: async () => new Map() } as never,
  );

  const NAMES = ['Duplicate switch', 'Duplicate switch', 'Duplicate switch', 'Duplicate switch', 'Aardvark AP'];

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.company.create({
      data: { id: COMPANY, name: 'Asset Pagination Spec Co', slug: 'phase2c-pagination-spec' },
    });
    await prisma.assetLayout.create({
      data: {
        id: LAYOUT,
        name: 'Pagination Spec Devices',
        slug: 'phase2c-pagination-spec-devices',
        icon: 'dns',
        color: '#0d7d72',
        fields: {
          create: [
            {
              id: '2ca00000-0000-4000-8000-00000000f001',
              name: 'Hostname',
              slug: 'hostname',
              fieldType: 'TEXT',
              position: 0,
              isPrimary: true,
            },
            // Phase 4 projection fixtures: one table column, one field
            // that only detail should carry, one TAGS field (always
            // projected — the admin table's tag filter needs it).
            {
              id: '2ca00000-0000-4000-8000-00000000f002',
              name: 'Rack',
              slug: 'rack',
              fieldType: 'TEXT',
              position: 1,
              showInTable: true,
            },
            {
              id: '2ca00000-0000-4000-8000-00000000f003',
              name: 'Serial notes',
              slug: 'serial_notes',
              fieldType: 'TEXTAREA',
              position: 2,
            },
            {
              id: '2ca00000-0000-4000-8000-00000000f004',
              name: 'Labels',
              slug: 'labels',
              fieldType: 'TAGS',
              position: 3,
            },
          ],
        },
      },
    });
    await prisma.asset.createMany({
      data: NAMES.map((name, i) => ({
        id: `2ca00000-0000-4000-8000-00000000b00${i}`,
        companyId: COMPANY,
        assetLayoutId: LAYOUT,
        name,
      })),
    });
    await prisma.assetFieldValue.createMany({
      data: [
        { companyId: COMPANY, assetId: '2ca00000-0000-4000-8000-00000000b000', assetFieldId: '2ca00000-0000-4000-8000-00000000f001', value: 'host-a' },
        { companyId: COMPANY, assetId: '2ca00000-0000-4000-8000-00000000b000', assetFieldId: '2ca00000-0000-4000-8000-00000000f002', value: 'R12' },
        { companyId: COMPANY, assetId: '2ca00000-0000-4000-8000-00000000b000', assetFieldId: '2ca00000-0000-4000-8000-00000000f003', value: 'long detail-only notes' },
        // Empty array: the include's TAGS clause must return the row,
        // and empty short-circuits tag hydration (the harness stubs the
        // tags collaborator).
        { companyId: COMPANY, assetId: '2ca00000-0000-4000-8000-00000000b000', assetFieldId: '2ca00000-0000-4000-8000-00000000f004', value: [] },
      ],
    });
  });

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { companyId: COMPANY } });
    await prisma.assetField.deleteMany({ where: { assetLayoutId: LAYOUT } });
    await prisma.assetLayout.deleteMany({ where: { id: LAYOUT } });
    await prisma.company.deleteMany({ where: { id: COMPANY } });
    await prisma.$disconnect();
  });

  it('walks duplicate-name pages without skipping or repeating a row', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = await service.list(OPERATOR, COMPANY, { limit: 2, cursor });
      seen.push(...page.items.map((a) => a.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (++guard > 10) throw new Error('pagination did not terminate');
    }

    expect(seen).toHaveLength(NAMES.length);
    expect(new Set(seen).size).toBe(NAMES.length);
  });

  it('orders duplicate names deterministically by id within the name group', async () => {
    const all = await service.list(OPERATOR, COMPANY, { limit: 50 });
    const dupIds = all.items.filter((a) => a.name === 'Duplicate switch').map((a) => a.id);
    expect(dupIds).toEqual([...dupIds].sort());
  });

  it('projects list fieldValues to isPrimary || showInTable || TAGS (Phase 4)', async () => {
    const all = await service.list(OPERATOR, COMPANY, { limit: 50 });
    const seeded = all.items.find(
      (a) => a.id === '2ca00000-0000-4000-8000-00000000b000',
    )!;
    // Primary + table column + TAGS survive the query-layer projection…
    expect(seeded.fieldValues).toHaveProperty('hostname', 'host-a');
    expect(seeded.fieldValues).toHaveProperty('rack', 'R12');
    expect(seeded.fieldValues).toHaveProperty('labels');
    // …and the detail-only field's value never leaves Postgres for a
    // list row (the value still exists — getById carries it).
    expect(seeded.fieldValues).not.toHaveProperty('serial_notes');
    const detail = await service.get(
      OPERATOR,
      COMPANY,
      '2ca00000-0000-4000-8000-00000000b000',
    );
    expect(detail.fieldValues).toHaveProperty(
      'serial_notes',
      'long detail-only notes',
    );
  });
});
