import { runWithTenantContext, type TenantContext } from '@weavestream/shared/server';
import { SearchService } from './search.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { PasswordAccessScope } from '../passwords/password-access-policy.js';

/**
 * DB-backed proof that global search applies the password access rule
 * (issue #110) to the rows PostgreSQL returns, not only to the SQL text:
 *   1. an entry with its own list uses only that list;
 *   2. else an active membership override (`allow` / `deny`) for the
 *      entry's company;
 *   3. else the global password access policy (`byDefault`).
 * Files attached to an entry follow the entry. `search.service.spec.ts`
 * stubs `$queryRaw`, so it cannot prove this.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1`: without the flag
 * this spec would write to the configured development database. Every
 * row it writes uses the ids below and is removed in `afterAll`. Run with:
 *   WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @weavestream/api test search.password-access.db
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const id = (suffix: string) => `5ac00000-0000-4000-8000-${suffix.padStart(12, '0')}`;

const ME = id('a001');
const OTHER = id('a002');
const CO_X = id('c001');
const CO_Y = id('c002');

/** Password entries. */
const P = {
  xOpen: id('b001'), // company X, no own list
  yOpen: id('b002'), // company Y, no own list
  xMine: id('b003'), // company X, own list includes ME
  xTheirs: id('b004'), // company X, own list excludes ME
};
/** Files attached to the entries above. */
const U = {
  xOpen: id('d001'),
  yOpen: id('d002'),
  xMine: id('d003'),
  xTheirs: id('d004'),
};

/** A word that only this spec's rows contain. */
const WORD = 'quokkafjord';

function actor(passwordAccess: PasswordAccessScope): AuthedUser {
  return {
    id: ME,
    email: 'search-password-access-spec@example.com',
    role: 'OPERATOR',
    globalAccess: 'FULL',
    platformCapabilities: [],
    sessionId: id('e001'),
    mfaEnforcementCompletedAt: null,
    mfaPending: false,
    passwordAccess,
  } as AuthedUser;
}

function ctxFor(user: AuthedUser): TenantContext {
  return {
    userId: user.id,
    role: user.role,
    email: user.email,
    allowedCompanyIds: [CO_X, CO_Y],
    isSuperAdmin: false,
    globalAccess: user.globalAccess,
    requestId: 'search-password-access-spec',
    ip: '127.0.0.1',
    userAgent: 'jest',
  };
}

describeIfDb('search password access (DB integration, issue #110)', () => {
  const prisma = new PrismaService();
  const search = new SearchService(prisma);

  async function hitIds(scope: PasswordAccessScope): Promise<string[]> {
    const user = actor(scope);
    const result = await runWithTenantContext(ctxFor(user), () =>
      search.search(user, { q: WORD, limit: 50 }),
    );
    return result.items.map((h) => h.id).sort();
  }

  const sorted = (...ids: string[]) => [...ids].sort();

  async function cleanup() {
    // Companies cascade to passwords, uploads and search_index rows.
    await prisma.company.deleteMany({ where: { id: { in: [CO_X, CO_Y] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ME, OTHER] } } });
  }

  beforeAll(async () => {
    await prisma.$connect();
    await cleanup();
    await prisma.user.createMany({
      data: [
        {
          id: ME,
          email: 'search-password-access-spec@example.com',
          name: 'Search Password Access Spec',
          passwordHash: 'x',
          role: 'OPERATOR',
          globalAccess: 'FULL',
        },
        {
          id: OTHER,
          email: 'search-password-access-spec-other@example.com',
          name: 'Search Password Access Spec Other',
          passwordHash: 'x',
          role: 'OPERATOR',
          globalAccess: 'FULL',
        },
      ],
    });
    await prisma.company.createMany({
      data: [
        { id: CO_X, name: 'Search PA Spec X', slug: 'search-pa-spec-x' },
        { id: CO_Y, name: 'Search PA Spec Y', slug: 'search-pa-spec-y' },
      ],
    });
    const entry = (pid: string, companyId: string, restrictedToUserIds: string[], label: string) => ({
      id: pid,
      companyId,
      name: `${WORD} ${label}`,
      passwordCiphertext: 'not-a-real-ciphertext',
      restrictedToUserIds,
      createdBy: ME,
      updatedBy: ME,
    });
    await prisma.password.createMany({
      data: [
        entry(P.xOpen, CO_X, [], 'x open'),
        entry(P.yOpen, CO_Y, [], 'y open'),
        entry(P.xMine, CO_X, [ME], 'x mine'),
        entry(P.xTheirs, CO_X, [OTHER], 'x theirs'),
      ],
    });
    const file = (uid: string, companyId: string, passwordId: string, label: string) => ({
      id: uid,
      companyId,
      uploaderId: ME,
      filename: `${WORD} ${label}.txt`,
      mimeType: 'text/plain',
      sizeBytes: 1,
      storageKey: `search-pa-spec/${uid}`,
      sha256: '0'.repeat(64),
      attachedToType: 'password',
      attachedToId: passwordId,
    });
    await prisma.upload.createMany({
      data: [
        file(U.xOpen, CO_X, P.xOpen, 'x open file'),
        file(U.yOpen, CO_Y, P.yOpen, 'y open file'),
        file(U.xMine, CO_X, P.xMine, 'x mine file'),
        file(U.xTheirs, CO_X, P.xTheirs, 'x theirs file'),
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('global allow + deny in company X: hides company X entries and files, keeps Y and own-list', async () => {
    expect(
      await hitIds({ byDefault: true, allowCompanyIds: [], denyCompanyIds: [CO_X] }),
    ).toEqual(sorted(P.yOpen, U.yOpen, P.xMine, U.xMine));
  });

  it('global deny + allow in company X: only company X entries and files, plus own-list', async () => {
    expect(
      await hitIds({ byDefault: false, allowCompanyIds: [CO_X], denyCompanyIds: [] }),
    ).toEqual(sorted(P.xOpen, U.xOpen, P.xMine, U.xMine));
  });

  it('global allow with empty override lists: every entry without a list, plus own-list', async () => {
    expect(
      await hitIds({ byDefault: true, allowCompanyIds: [], denyCompanyIds: [] }),
    ).toEqual(sorted(P.xOpen, U.xOpen, P.yOpen, U.yOpen, P.xMine, U.xMine));
  });

  it('global deny with empty override lists: only the own-list entry and its file', async () => {
    expect(
      await hitIds({ byDefault: false, allowCompanyIds: [], denyCompanyIds: [] }),
    ).toEqual(sorted(P.xMine, U.xMine));
  });

  it('never returns an entry whose own list excludes the user, even in an allowed company', async () => {
    const hits = await hitIds({ byDefault: true, allowCompanyIds: [CO_X], denyCompanyIds: [] });
    expect(hits).not.toContain(P.xTheirs);
    expect(hits).not.toContain(U.xTheirs);
  });
});
