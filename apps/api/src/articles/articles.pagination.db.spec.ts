import { ArticlesService } from './articles.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * DB-backed regression guard for cursor pagination over the articles
 * list (Phase 2b mobile).
 *
 * The list orders by `(archivedAt, title, id)` — `id` is the unique
 * tie-breaker Prisma cursor pagination requires. The in-memory Prisma
 * fakes used by `articles.service.spec.ts` ignore `orderBy` entirely,
 * so only a real Postgres can prove duplicate titles don't make pages
 * skip or repeat rows.
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
 * Deliberately NOT tested: stability when the cursor row's title is
 * renamed between pages. That is an accepted weakness of cursoring
 * over a mutable, user-visible alphabetical order (see the orderBy
 * comment in `articles.service.ts`).
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const COMPANY = '2ba00000-0000-4000-8000-00000000c001';

const OPERATOR: AuthedUser = {
  id: '2ba00000-0000-4000-8000-00000000a001',
  email: 'pagination-spec@example.com',
  role: 'OPERATOR',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: '2ba00000-0000-4000-8000-00000000e001',
  mfaEnforcementCompletedAt: null,
  mfaPending: false,
};

describeIfDb('articles list cursor pagination (DB integration)', () => {
  const prisma = new PrismaService();
  // list() touches only prisma (+ hydrateActors, skipped for null actors);
  // the write-path collaborators are never reached.
  const service = new ArticlesService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const TITLES = ['Duplicate runbook', 'Duplicate runbook', 'Duplicate runbook', 'Duplicate runbook', 'Aardvark first'];

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.company.create({
      data: { id: COMPANY, name: 'Pagination Spec Co', slug: 'phase2b-pagination-spec' },
    });
    await prisma.article.createMany({
      data: TITLES.map((title, i) => ({
        id: `2ba00000-0000-4000-8000-00000000b00${i}`,
        companyId: COMPANY,
        title,
        slug: `pagination-spec-${i}`,
        editorMode: 'markdown',
        markdownSource: `# ${title} ${i}`,
        contentPlaintext: `${title} ${i}`,
      })),
    });
  });

  afterAll(async () => {
    await prisma.article.deleteMany({ where: { companyId: COMPANY } });
    await prisma.company.deleteMany({ where: { id: COMPANY } });
    await prisma.$disconnect();
  });

  it('walks duplicate-title pages without skipping or repeating a row', async () => {
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

    expect(seen).toHaveLength(TITLES.length);
    expect(new Set(seen).size).toBe(TITLES.length);
  });

  it('orders duplicate titles deterministically by id within the title group', async () => {
    const all = await service.list(OPERATOR, COMPANY, { limit: 50 });
    const dupIds = all.items.filter((a) => a.title === 'Duplicate runbook').map((a) => a.id);
    expect(dupIds).toEqual([...dupIds].sort());
  });
});
