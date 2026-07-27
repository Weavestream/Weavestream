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
    {} as never,
    {} as never,
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
});
