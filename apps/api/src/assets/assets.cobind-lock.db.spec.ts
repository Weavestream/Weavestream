import { randomUUID } from 'node:crypto';
import { AssetsService, type IntegrationAssetWriteInput } from './assets.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * DB-backed guard for the co-bind advisory lock. `pg_advisory_xact_lock`
 * returns `void`, which Prisma's `$queryRaw` cannot deserialize, so every
 * co-bind threw on a real database while the mocked unit suite passed.
 * Only a real Postgres proves the lock statement runs.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1` (same gating as
 * `assets.pagination.db.spec.ts`). Run locally with:
 *   WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @weavestream/api test
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const COMPANY = 'cb100000-0000-4000-8000-00000000c001';
const LAYOUT = 'cb100000-0000-4000-8000-00000000d001';
const ASSET = 'cb100000-0000-4000-8000-00000000b001';

describeIfDb('asset co-bind lock (DB integration)', () => {
  const prisma = new PrismaService();
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

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.company.create({
      data: { id: COMPANY, name: 'Co-bind Lock Spec Co', slug: 'cobind-lock-spec' },
    });
    await prisma.assetLayout.create({
      data: { id: LAYOUT, name: 'Co-bind Lock Spec', slug: 'cobind-lock-spec', icon: 'dns', color: '#0d7d72' },
    });
    await prisma.asset.create({
      data: {
        id: ASSET,
        companyId: COMPANY,
        assetLayoutId: LAYOUT,
        name: 'Shared device',
        externalSource: 'level',
        externalId: 'lvl-1',
      },
    });
  });

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { companyId: COMPANY } });
    await prisma.assetLayout.deleteMany({ where: { id: LAYOUT } });
    await prisma.company.deleteMany({ where: { id: COMPANY } });
    await prisma.$disconnect();
  });

  it('takes the advisory lock and co-binds inside a real page transaction', async () => {
    const target = await prisma.asset.findUniqueOrThrow({ where: { id: ASSET } });
    const coBindable = await prisma.$transaction((tx) =>
      service['isCoBindable'](
        {
          tx,
          companyId: COMPANY,
          assetLayoutId: LAYOUT,
          integrationId: randomUUID(),
          coBindSources: ['level'],
        } as unknown as IntegrationAssetWriteInput,
        target,
        tx,
      ),
    );
    expect(coBindable).toBe(true);
  });
});
