import { PrismaService } from '../prisma/prisma.service.js';
import { pruneAssetVersions } from './asset-versions-retention.js';

/**
 * DB-backed proof of the SQL that mocks cannot check: FK cascade on purge,
 * the JSONB key removal used by redaction, and the retention prune that
 * keeps the first and latest version. Opt-in via
 * `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1` (same gating as the other
 * `*.db.spec.ts`). NOT run in the sandbox this was written in (no Docker).
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const COMPANY = 'cb200000-0000-4000-8000-00000000c001';
const LAYOUT = 'cb200000-0000-4000-8000-00000000d001';
const ASSET = 'cb200000-0000-4000-8000-00000000b001';
const FIELD = 'cb200000-0000-4000-8000-00000000f001';

describeIfDb('asset_versions (DB integration)', () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.company.create({ data: { id: COMPANY, name: 'Versions Spec Co', slug: 'versions-spec' } });
    await prisma.assetLayout.create({
      data: { id: LAYOUT, name: 'Versions Spec', slug: 'versions-spec', icon: 'dns', color: '#0d7d72' },
    });
    await prisma.asset.create({
      data: { id: ASSET, companyId: COMPANY, assetLayoutId: LAYOUT, name: 'Spec asset' },
    });
    const old = new Date('2020-01-01T00:00:00.000Z');
    for (let version = 1; version <= 4; version += 1) {
      await prisma.assetVersion.create({
        data: {
          assetId: ASSET,
          companyId: COMPANY,
          version,
          name: 'Spec asset',
          fieldValues: { [FIELD]: `secret-${version}`, other: 'keep' },
          createdAt: old,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.asset.deleteMany({ where: { companyId: COMPANY } });
    await prisma.assetLayout.deleteMany({ where: { id: LAYOUT } });
    await prisma.company.deleteMany({ where: { id: COMPANY } });
    await prisma.$disconnect();
  });

  it('the retention prune keeps the first and latest version of the asset', async () => {
    const dry = await pruneAssetVersions(prisma, { olderThanDays: 30, dryRun: true });
    expect(dry.eligible).toBeGreaterThanOrEqual(2);
    await pruneAssetVersions(prisma, { olderThanDays: 30, dryRun: false });
    const left = await prisma.assetVersion.findMany({
      where: { assetId: ASSET, companyId: COMPANY },
      orderBy: { version: 'asc' },
      select: { version: true },
    });
    expect(left.map((v) => v.version)).toEqual([1, 4]);
  });

  it('removes a JSON key from every version of the asset only', async () => {
    const n = await prisma.$executeRaw`UPDATE asset_versions
      SET field_values = field_values - ${FIELD}::text, redacted_at = now()
      WHERE asset_id = ${ASSET}::uuid AND company_id = ${COMPANY}::uuid
        AND jsonb_exists(field_values, ${FIELD}::text)`;
    expect(n).toBe(2);
    const rows = await prisma.assetVersion.findMany({ where: { assetId: ASSET, companyId: COMPANY } });
    for (const r of rows) {
      expect(r.fieldValues).toEqual({ other: 'keep' });
      expect(r.redactedAt).not.toBeNull();
    }
  });

  it('purging the asset cascades its versions', async () => {
    await prisma.asset.delete({ where: { id: ASSET } });
    const left = await prisma.assetVersion.count({ where: { assetId: ASSET, companyId: COMPANY } });
    expect(left).toBe(0);
  });
});
