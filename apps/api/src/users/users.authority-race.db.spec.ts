import { UsersService } from './users.service.js';
import { ApiKeyService } from '../auth/api-key.service.js';
import { lockUserForAuthorityChange } from '../auth/revoke-api-keys.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * DB-backed proof for pentest 3b3f rec. 6 review finding 1: an authority edit
 * must judge "did authority change?" against the row it locked, so a
 * concurrent edit plus a key minted in between cannot slip past revocation.
 *
 * Only real Postgres can show this: the unit suite checks the lock is taken
 * and read in order, not that the lock serializes. This spec fails on the
 * pre-fix code (which read `before` outside the transaction) — the key
 * survives the promotion.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1` (same gating rationale
 * as `chat-tool-call.concurrency.db.spec.ts`). Run locally with:
 *   WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @weavestream/api test -- users.authority-race
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const USER = '5bc00000-0000-4000-8000-0000000ab001';
const ADMIN = '5bc00000-0000-4000-8000-0000000ab002';
const META = { ip: '127.0.0.1', userAgent: 'db-spec' };

const ACTOR: AuthedUser = {
  id: ADMIN,
  email: 'authority-race-admin@example.com',
  role: 'SUPER_ADMIN',
  globalAccess: null,
  platformCapabilities: [],
  sessionId: '5bc00000-0000-4000-8000-0000000ab0f1',
  mfaEnforcementCompletedAt: null,
  mfaPending: false,
};

describeIfDb('UsersService.update vs. concurrent authority edits (DB)', () => {
  const prisma = new PrismaService();
  const audit = {
    log: jest.fn().mockResolvedValue(undefined),
    logWithClient: jest.fn().mockResolvedValue(undefined),
  };
  const users = new UsersService(
    prisma,
    audit as never,
    { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
  );
  const apiKeys = new ApiKeyService(prisma, audit as never, {
    apiKeysEnabled: jest.fn().mockResolvedValue(true),
  } as never);

  /** Resolves once some backend is waiting on a lock held by `holderPid`. */
  async function untilBlockedBy(holderPid: number): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
      `;
      if ((row?.n ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`nothing ever blocked on backend ${holderPid}`);
  }

  async function backendPid(tx: { $queryRaw: PrismaService['$queryRaw'] }): Promise<number> {
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    return row!.pid;
  }

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.createMany({
      data: [
        { id: ADMIN, email: ACTOR.email, name: 'Race Admin', role: 'SUPER_ADMIN' },
        {
          id: USER,
          email: 'authority-race-user@example.com',
          name: 'Race User',
          role: 'OPERATOR',
          globalAccess: 'FULL',
        },
      ],
    });
  });

  beforeEach(async () => {
    await prisma.apiKey.deleteMany({ where: { userId: USER } });
    await prisma.user.update({
      where: { id: USER },
      data: { globalAccess: 'FULL', isActive: true, deactivatedAt: null },
    });
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
    await prisma.$disconnect();
  });

  it('revokes a key minted after a concurrent downgrade when a stale edit re-promotes', async () => {
    let commitB!: () => void;
    const bMayCommit = new Promise<void>((r) => (commitB = r));
    let keyId = '';
    let bPid!: (pid: number) => void;
    const bLocked = new Promise<number>((r) => (bPid = r));

    // Edit B: downgrade to READONLY, and the user mints a key at READONLY.
    // Held open until edit A is queued behind it.
    const b = prisma.$transaction(
      async (tx) => {
        await lockUserForAuthorityChange(tx, USER);
        bPid(await backendPid(tx));
        await tx.user.update({ where: { id: USER }, data: { globalAccess: 'READONLY' } });
        const minted = await apiKeys.mint(
          { userId: USER, name: 'minted-at-readonly', createdBy: USER },
          tx,
        );
        keyId = minted.record.id;
        await bMayCommit;
      },
      { timeout: 15_000 },
    );

    // Edit A started while the user was still FULL and writes FULL.
    const holder = await bLocked;
    const a = users.update(ACTOR, USER, { globalAccess: 'FULL' }, META);
    await untilBlockedBy(holder);
    commitB();
    await b;
    await a;

    const key = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
    expect(key.revokedAt).not.toBeNull();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
    expect(user.globalAccess).toBe('FULL');
  });

  it('makes a key mint wait for an open authority edit', async () => {
    let commitEdit!: () => void;
    const editMayCommit = new Promise<void>((r) => (commitEdit = r));
    let editPid!: (pid: number) => void;
    const editLocked = new Promise<number>((r) => (editPid = r));
    const edit = prisma.$transaction(
      async (tx) => {
        await lockUserForAuthorityChange(tx, USER);
        editPid(await backendPid(tx));
        await editMayCommit;
      },
      { timeout: 15_000 },
    );
    const holder = await editLocked;

    let minted = false;
    const mint = apiKeys
      .create({ ...ACTOR, id: USER, role: 'OPERATOR', globalAccess: 'FULL' }, { name: 'k' }, META)
      .then(() => {
        minted = true;
      });
    await untilBlockedBy(holder);
    expect(minted).toBe(false);
    commitEdit();
    await edit;
    await mint;
    expect(minted).toBe(true);
  });

  // Not a race: rides on this file's real-Postgres setup. Proves the
  // PATCH/DELETE /users/:id payload is projected by the query itself, with
  // the secret columns populated in the row.
  it('PATCH and DELETE responses never carry passwordHash or mfaSecretEncrypted', async () => {
    await prisma.user.update({
      where: { id: USER },
      data: { passwordHash: 'not-a-real-hash', mfaSecretEncrypted: 'not-a-real-ciphertext' },
    });
    await apiKeys.create(
      { ...ACTOR, id: USER, role: 'OPERATOR', globalAccess: 'FULL' },
      { name: 'k' },
      META,
    );

    const patched = await users.update(ACTOR, USER, { globalAccess: 'READONLY' }, META);
    expect(patched).not.toHaveProperty('passwordHash');
    expect(patched).not.toHaveProperty('mfaSecretEncrypted');
    expect(patched).toMatchObject({ globalAccess: 'READONLY', apiKeysRevoked: 1 });

    const deactivated = await users.deactivate(ACTOR, USER, META);
    expect(deactivated).not.toHaveProperty('passwordHash');
    expect(deactivated).not.toHaveProperty('mfaSecretEncrypted');
    expect(deactivated).toMatchObject({ isActive: false, apiKeysRevoked: 0 });
  });
});
