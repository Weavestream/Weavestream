import { NotFoundException } from '@nestjs/common';
import { FoldersService } from './folders.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { SerializedFolderNode } from './folders.service.js';

/**
 * DB-backed guard for the CLIENT_USER folder-visibility rule (Phase 2b):
 * the recursive CTE in `clientVisibleFolderIds` is real SQL, so its
 * tenant boundary, ancestor-chain recursion, duplicate-seed dedup, and
 * cycle termination can only be proven against Postgres — mocks would
 * pass vacuously.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1` (set in CI's test
 * job, which provisions Postgres + `prisma migrate deploy`). Gating on
 * `DATABASE_URL` alone is NOT sufficient: importing `@prisma/client`
 * loads the workspace `.env`, so the variable is set even in a bare
 * local `pnpm test` and the spec would mutate the configured
 * *development* database. An explicit flag keeps mutation opt-in.
 * Run locally with:
 *   WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @weavestream/api test
 *
 * The deliberate `parentId` cycle is asserted through `get()`, not
 * `tree()`: the tree assembler gives a cycle no root, so cyclic nodes
 * are absent from tree() output even though the CTE handles them —
 * `get()` consults allowlist membership directly.
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const A = '2bf00000-0000-4000-8000-00000000c001';
const B = '2bf00000-0000-4000-8000-00000000c002';

const F = {
  ops: '2bf00000-0000-4000-8000-00000000f001',
  opsChild: '2bf00000-0000-4000-8000-00000000f002',
  internalRoot: '2bf00000-0000-4000-8000-00000000f003',
  internalChild: '2bf00000-0000-4000-8000-00000000f004',
  mixed: '2bf00000-0000-4000-8000-00000000f005',
  cycA: '2bf00000-0000-4000-8000-00000000f006',
  cycB: '2bf00000-0000-4000-8000-00000000f007',
  bRoot: '2bf00000-0000-4000-8000-00000000f101',
};

const CLIENT: AuthedUser = {
  id: '2bf00000-0000-4000-8000-00000000a001',
  email: 'folders-spec-client@example.com',
  role: 'CLIENT_USER',
  globalAccess: null,
  platformCapabilities: [],
  sessionId: '2bf00000-0000-4000-8000-00000000e001',
  mfaEnforcementCompletedAt: null,
  mfaPending: false,
};

const OPERATOR: AuthedUser = {
  ...CLIENT,
  id: '2bf00000-0000-4000-8000-00000000a002',
  email: 'folders-spec-op@example.com',
  role: 'OPERATOR',
  globalAccess: 'FULL',
};

function names(nodes: SerializedFolderNode[]): string[] {
  return nodes.flatMap((n) => [n.name, ...names(n.children)]);
}

function findNode(nodes: SerializedFolderNode[], id: string): SerializedFolderNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

describeIfDb('folder client visibility (DB integration)', () => {
  const prisma = new PrismaService();
  const service = new FoldersService(prisma, {} as never);

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.company.createMany({
      data: [
        { id: A, name: 'Folders Spec Co A', slug: 'phase2b-folders-spec-a' },
        { id: B, name: 'Folders Spec Co B', slug: 'phase2b-folders-spec-b' },
      ],
    });
    await prisma.folder.createMany({
      data: [
        { id: F.ops, companyId: A, name: 'ops', slug: 'ops' },
        { id: F.opsChild, companyId: A, parentId: F.ops, name: 'ops-child', slug: 'ops-child' },
        { id: F.internalRoot, companyId: A, name: 'internal-root', slug: 'internal-root' },
        { id: F.internalChild, companyId: A, parentId: F.internalRoot, name: 'internal-child', slug: 'internal-child' },
        { id: F.mixed, companyId: A, name: 'mixed', slug: 'mixed' },
        { id: F.cycA, companyId: A, name: 'cyc-a', slug: 'cyc-a' },
        { id: F.cycB, companyId: A, parentId: F.cycA, name: 'cyc-b', slug: 'cyc-b' },
        { id: F.bRoot, companyId: B, name: 'b-root', slug: 'b-root' },
      ],
    });
    const article = (id: string, companyId: string, folderId: string, visible: boolean, i: number) => ({
      id,
      companyId,
      folderId,
      title: `Folders spec ${i}`,
      slug: `folders-spec-${i}`,
      editorMode: 'markdown',
      markdownSource: `# ${i}`,
      contentPlaintext: `${i}`,
      visibleToClients: visible,
    });
    await prisma.article.createMany({
      data: [
        // duplicate visible seeds in one folder — folder must appear once
        article('2bf00000-0000-4000-8000-00000000d001', A, F.opsChild, true, 1),
        article('2bf00000-0000-4000-8000-00000000d002', A, F.opsChild, true, 2),
        article('2bf00000-0000-4000-8000-00000000d003', A, F.internalChild, false, 3),
        article('2bf00000-0000-4000-8000-00000000d004', A, F.mixed, true, 4),
        article('2bf00000-0000-4000-8000-00000000d005', A, F.mixed, false, 5),
        article('2bf00000-0000-4000-8000-00000000d006', A, F.cycB, true, 6),
        article('2bf00000-0000-4000-8000-00000000d007', B, F.bRoot, true, 7),
      ],
    });
    // App code refuses to create a parentId cycle, so wire one directly.
    // The CTE must terminate on it (UNION dedup); asserted via get() below.
    await prisma.$executeRaw`UPDATE folders SET parent_id = ${F.cycB}::uuid WHERE id = ${F.cycA}::uuid`;
  });

  afterAll(async () => {
    await prisma.article.deleteMany({ where: { companyId: { in: [A, B] } } });
    // Break the cycle (and all parent links) before deleting: the folder
    // self-relation is onDelete: Restrict.
    await prisma.folder.updateMany({
      where: { companyId: { in: [A, B] } },
      data: { parentId: null },
    });
    await prisma.folder.deleteMany({ where: { companyId: { in: [A, B] } } });
    await prisma.company.deleteMany({ where: { id: { in: [A, B] } } });
    await prisma.$disconnect();
  });

  it('prunes the client tree to folders with a visible article in their subtree', async () => {
    const tree = await service.tree(CLIENT, A);
    const flat = names(tree);
    expect(flat).toEqual(expect.arrayContaining(['ops', 'ops-child', 'mixed']));
    expect(flat).not.toContain('internal-root');
    expect(flat).not.toContain('internal-child');
    expect(flat).not.toContain('b-root');
    // Ancestor chain: ops has no visible article itself but hosts a
    // visible leaf, so it stays, with the leaf attached beneath it.
    const ops = findNode(tree, F.ops);
    expect(ops?.children.map((c) => c.id)).toEqual([F.opsChild]);
    // Duplicate visible seeds: one folder row, count of 2.
    expect(findNode(tree, F.opsChild)?.articleCount).toBe(2);
  });

  it('excludes internal articles from client counts', async () => {
    const clientTree = await service.tree(CLIENT, A);
    expect(findNode(clientTree, F.mixed)?.articleCount).toBe(1);
    const operatorTree = await service.tree(OPERATOR, A);
    expect(findNode(operatorTree, F.mixed)?.articleCount).toBe(2);
  });

  it('keeps the operator tree unfiltered', async () => {
    const tree = await service.tree(OPERATOR, A);
    const flat = names(tree);
    expect(flat).toEqual(
      expect.arrayContaining(['ops', 'ops-child', 'internal-root', 'internal-child', 'mixed']),
    );
    expect(flat).not.toContain('b-root');
    expect(findNode(tree, F.opsChild)?.articleCount).toBe(2);
  });

  it('404s get() of an internal-only folder for a client, 200s it for an operator', async () => {
    await expect(service.get(CLIENT, A, F.internalChild)).rejects.toThrow(NotFoundException);
    await expect(service.get(OPERATOR, A, F.internalChild)).resolves.toMatchObject({
      name: 'internal-child',
    });
  });

  it('terminates on a parentId cycle and grants the cycle members holding visible content', async () => {
    // cyc-b holds a visible article; cyc-a is its "ancestor" through the
    // cycle. Membership via get() proves the CTE walked the cycle and
    // stopped — tree() can never show these nodes (a cycle has no root).
    await expect(service.get(CLIENT, A, F.cycA)).resolves.toMatchObject({ name: 'cyc-a' });
    await expect(service.get(CLIENT, A, F.cycB)).resolves.toMatchObject({ name: 'cyc-b' });
    const tree = await service.tree(CLIENT, A);
    expect(names(tree)).not.toEqual(expect.arrayContaining(['cyc-a']));
  });

  it('enforces the tenant boundary in get()', async () => {
    await expect(service.get(CLIENT, A, F.bRoot)).rejects.toThrow(NotFoundException);
    const treeB = await service.tree(CLIENT, B);
    expect(names(treeB)).toEqual(['b-root']);
  });
});
