import { markdownToPlaintext } from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { refreshMarkdownPlaintext } from './markdown-plaintext-refresh.service.js';

/**
 * DB-backed guard for `refreshMarkdownPlaintext`: the guarded raw
 * UPDATE must match real column names, leave `updated_at` alone, fire
 * the `articles` search-index trigger, and skip a row whose source
 * changed after the batch was read. The unit spec fakes `$executeRaw`,
 * so only Postgres proves the SQL.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1` (see
 * `articles.pagination.db.spec.ts` for why `DATABASE_URL` alone is not
 * enough).
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const COMPANY = '2ba00000-0000-4000-8000-00000000c085';
const STALE = '2ba00000-0000-4000-8000-00000000b851';
const EDITED = '2ba00000-0000-4000-8000-00000000b852';
const SOURCE = 'Run `create_article` and `update_article`:\n\n```\nGet-Service -Name Spooler\n```';
const UPDATED_AT = new Date('2024-02-03T04:05:06.000Z');

describeIfDb('refreshMarkdownPlaintext (DB integration)', () => {
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.company.create({
      data: { id: COMPANY, name: 'Markdown Refresh Spec Co', slug: 'markdown-refresh-spec' },
    });
    await prisma.article.createMany({
      data: [STALE, EDITED].map((id, i) => ({
        id,
        companyId: COMPANY,
        title: `Refresh spec ${i}`,
        slug: `markdown-refresh-spec-${i}`,
        editorMode: 'markdown',
        markdownSource: SOURCE,
        contentPlaintext: 'Run createarticle and updatearticle:',
        updatedAt: UPDATED_AT,
      })),
    });
  });

  afterAll(async () => {
    await prisma.article.deleteMany({ where: { companyId: COMPANY } });
    await prisma.company.deleteMany({ where: { id: COMPANY } });
    await prisma.$disconnect();
  });

  it('rewrites stale text, keeps updated_at, reindexes, and skips a row edited mid-run', async () => {
    const realFindMany = prisma.article.findMany.bind(prisma.article);
    const spy = jest.spyOn(prisma.article, 'findMany').mockImplementation((async (args: unknown) => {
      const rows = await realFindMany(args as never);
      // An edit lands after the batch was read but before it is written.
      await prisma.article.update({
        where: { id: EDITED },
        data: { markdownSource: 'Edited meanwhile', contentPlaintext: 'Edited meanwhile' },
      });
      spy.mockRestore();
      return rows.filter((r) => [STALE, EDITED].includes(r.id));
    }) as never);

    await expect(refreshMarkdownPlaintext(prisma)).resolves.toBe(1);

    const stale = await prisma.article.findUniqueOrThrow({ where: { id: STALE } });
    expect(stale.contentPlaintext).toBe(markdownToPlaintext(SOURCE));
    expect(stale.contentPlaintext).toContain('update_article');
    expect(stale.contentPlaintext).toContain('Get-Service -Name Spooler');
    expect(stale.updatedAt.toISOString()).toBe(UPDATED_AT.toISOString());

    const index = await prisma.searchIndex.findUniqueOrThrow({
      where: { entityType_entityId: { entityType: 'article', entityId: STALE } },
    });
    expect(index.bodyInternal).toContain('update_article');

    const edited = await prisma.article.findUniqueOrThrow({ where: { id: EDITED } });
    expect(edited.contentPlaintext).toBe('Edited meanwhile');
  });
});
