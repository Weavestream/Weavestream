import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type {
  Password,
  PasswordFolder,
  PasswordVersion,
  Prisma,
  TotpAlgo,
} from '@prisma/client';
import { PasswordsService } from './passwords.service.js';
import { computePasswordStrength } from './password-strength.js';
import { passwordVaultAad } from '../crypto/secret-encryption.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { FULL_PASSWORD_ACCESS, NO_PASSWORD_ACCESS } from './password-access-policy.js';

/**
 * Phase 10 — PasswordsService unit suite.
 *
 * The service has a large surface, so the tests focus on the
 * security-critical paths:
 *   1. Tenant scoping — a password on company B is invisible to
 *      queries scoped to company A.
 *   2. Role scoping — CLIENT_USER only sees `visibleToClients=true`
 *      rows on both list + detail + reveal.
 *   3. restrictedToUserIds — operators not on the allow-list are
 *      rejected with 403 on reveal, even if they can otherwise read.
 *   4. requireReasonToView — reveal without a reason is rejected
 *      with a `ReasonRequired` BadRequest.
 *   5. Archive + restore round-trip sets / clears `archivedAt`.
 *   6. Cascade archive — archiving an asset only flips passwords
 *      that are linked to it, and only those that are currently
 *      active.
 *   7. Versioning — mutations to versioned fields append to
 *      `password_versions`, pure-metadata edits don't.
 *   8. Reveal audit — every reveal writes exactly one audit row.
 */

type DeepPartial<T> = { [K in keyof T]?: T[K] };

function now(offset = 0): Date {
  return new Date(Date.now() + offset);
}

type StoredPassword = Password;
type StoredVersion = PasswordVersion;

function passwordRow(init: DeepPartial<Password> = {}): StoredPassword {
  const created = new Date('2026-01-01T00:00:00Z');
  return {
    id: init.id ?? 'pwd-1',
    companyId: init.companyId ?? 'co-1',
    folderId: init.folderId ?? null,
    assetId: init.assetId ?? null,
    name: init.name ?? 'Acme VPN',
    username: init.username ?? 'ops@acme.test',
    url: init.url ?? 'https://vpn.acme.test',
    color: init.color ?? null,
    tags: init.tags ?? [],
    notesCiphertext: init.notesCiphertext ?? null,
    passwordCiphertext: init.passwordCiphertext ?? 'ENC(super-secret)',
    totpSecretCiphertext: init.totpSecretCiphertext ?? null,
    totpAlgorithm: (init.totpAlgorithm ?? 'SHA1') as TotpAlgo,
    totpDigits: init.totpDigits ?? 6,
    totpPeriod: init.totpPeriod ?? 30,
    passwordStrength: init.passwordStrength ?? 4,
    pwnedCount: init.pwnedCount ?? 0,
    lastRotatedAt: init.lastRotatedAt ?? created,
    rotationReminderDays: init.rotationReminderDays ?? null,
    expiresAt: init.expiresAt ?? null,
    visibleToClients: init.visibleToClients ?? false,
    requireReasonToView: init.requireReasonToView ?? false,
    restrictedToUserIds: init.restrictedToUserIds ?? [],
    archivedAt: init.archivedAt ?? null,
    createdBy: init.createdBy ?? 'user-op',
    updatedBy: init.updatedBy ?? 'user-op',
    createdAt: init.createdAt ?? created,
    updatedAt: init.updatedAt ?? created,
  } as Password;
}

function matchPassword(
  row: StoredPassword,
  where: Prisma.PasswordWhereInput,
): boolean {
  if (Array.isArray(where.AND)) {
    if (!where.AND.every((w) => matchPassword(row, w))) return false;
  }
  if (Array.isArray(where.OR)) {
    if (!where.OR.some((w) => matchPassword(row, w))) return false;
  }
  if (where.id && (where.id as string) !== row.id) return false;
  if (
    where.updatedAt instanceof Date &&
    row.updatedAt.getTime() !== where.updatedAt.getTime()
  ) {
    return false;
  }
  if (where.companyId && (where.companyId as string) !== row.companyId)
    return false;
  if (
    typeof where.assetId === 'string' &&
    where.assetId !== (row.assetId ?? '')
  ) {
    return false;
  }
  if (
    where.archivedAt !== undefined &&
    where.archivedAt === null &&
    row.archivedAt !== null
  ) {
    return false;
  }
  if (
    where.archivedAt !== undefined &&
    typeof where.archivedAt === 'object' &&
    where.archivedAt !== null &&
    'not' in where.archivedAt &&
    row.archivedAt === null
  ) {
    return false;
  }
  if (
    typeof where.visibleToClients === 'boolean' &&
    where.visibleToClients !== row.visibleToClients
  ) {
    return false;
  }
  if (
    where.restrictedToUserIds &&
    typeof where.restrictedToUserIds === 'object'
  ) {
    const filter = where.restrictedToUserIds as {
      isEmpty?: boolean;
      has?: string;
    };
    if (
      filter.isEmpty === true &&
      row.restrictedToUserIds.length !== 0
    ) {
      return false;
    }
    if (filter.has && !row.restrictedToUserIds.includes(filter.has)) {
      return false;
    }
  }
  return true;
}

type StubAccessUser = {
  id: string;
  email: string;
  name: string;
  role: 'OPERATOR' | 'CONTRACTOR' | 'CLIENT_USER' | 'SUPER_ADMIN';
  isActive?: boolean;
  globalAccess?: 'FULL' | 'READONLY' | 'NONE' | null;
};

function folderRow(init: DeepPartial<PasswordFolder> = {}): PasswordFolder {
  const created = new Date('2026-01-01T00:00:00Z');
  return {
    id: init.id ?? 'fld-1',
    companyId: init.companyId ?? 'co-1',
    parentId: init.parentId ?? null,
    name: init.name ?? 'Folder',
    icon: init.icon ?? null,
    color: init.color ?? null,
    position: init.position ?? 0,
    archivedAt: init.archivedAt ?? null,
    createdBy: init.createdBy ?? 'user-op',
    createdAt: init.createdAt ?? created,
    updatedAt: init.updatedAt ?? created,
  } as PasswordFolder;
}

function matchFolder(
  row: PasswordFolder,
  where: Prisma.PasswordFolderWhereInput,
): boolean {
  if (where.id && (where.id as string) !== row.id) return false;
  if (where.companyId && (where.companyId as string) !== row.companyId)
    return false;
  if (where.archivedAt === null && row.archivedAt !== null) return false;
  return true;
}

function makeStubs(
  initial: {
    passwords?: StoredPassword[];
    accessUsers?: StubAccessUser[];
    folders?: PasswordFolder[];
  } = {},
) {
  const passwords: StoredPassword[] = [...(initial.passwords ?? [])];
  const accessUsers: StubAccessUser[] = [...(initial.accessUsers ?? [])];
  const versions: StoredVersion[] = [];
  const folders: PasswordFolder[] = [...(initial.folders ?? [])];
  let versionSeq = 0;
  let passwordSeq = passwords.length;

  type PrismaStub = {
    $transaction: <T>(fn: (tx: PrismaStub) => Promise<T>) => Promise<T>;
    password: Record<string, (...args: never[]) => Promise<unknown>>;
    passwordVersion: Record<string, (...args: never[]) => Promise<unknown>>;
    passwordFolder: Record<string, (...args: never[]) => Promise<unknown>>;
    user: Record<string, (...args: never[]) => Promise<unknown>>;
    membership: Record<string, (...args: never[]) => Promise<unknown>>;
    asset: Record<string, (...args: never[]) => Promise<unknown>>;
  };
  const prisma: PrismaStub = {
    $transaction: async <T>(fn: (tx: PrismaStub) => Promise<T>) => fn(prisma),
    password: {
      async findFirst(args: { where: Prisma.PasswordWhereInput }) {
        return passwords.find((p) => matchPassword(p, args.where)) ?? null;
      },
      async findFirstOrThrow(args: { where: Prisma.PasswordWhereInput }) {
        const row = passwords.find((p) => matchPassword(p, args.where));
        if (!row) throw new Error('not found');
        return row;
      },
      async findMany(args: {
        where: Prisma.PasswordWhereInput;
        select?: unknown;
        orderBy?: unknown;
      }) {
        return passwords.filter((p) => matchPassword(p, args.where));
      },
      async create(args: { data: Prisma.PasswordUncheckedCreateInput }) {
        passwordSeq += 1;
        const row = passwordRow({
          ...(args.data as DeepPartial<Password>),
          id: (args.data.id as string | undefined) ?? `pwd-${passwordSeq}`,
        });
        passwords.push(row);
        return row;
      },
      async updateMany(args: {
        where: Prisma.PasswordWhereInput;
        data: Partial<Password>;
      }) {
        let count = 0;
        for (const row of passwords) {
          if (matchPassword(row, args.where)) {
            Object.assign(row, args.data, { updatedAt: new Date() });
            count += 1;
          }
        }
        return { count };
      },
    },
    passwordVersion: {
      async create(args: { data: Prisma.PasswordVersionUncheckedCreateInput }) {
        versionSeq += 1;
        const row = {
          id: `pv-${versionSeq}`,
          createdAt: new Date(),
          ...args.data,
        } as unknown as StoredVersion;
        versions.push(row);
        return row;
      },
      async findFirst(args: { where: Prisma.PasswordVersionWhereInput }) {
        return (
          versions.find(
            (v) =>
              (!args.where.passwordId ||
                v.passwordId === args.where.passwordId) &&
              (!args.where.companyId ||
                v.companyId === args.where.companyId) &&
              (args.where.version === undefined ||
                v.version === args.where.version),
          ) ?? null
        );
      },
      async findMany() {
        return versions;
      },
      async aggregate(args: { where: Prisma.PasswordVersionWhereInput }) {
        const own = versions.filter((v) => v.passwordId === args.where.passwordId);
        const max = own.length > 0 ? Math.max(...own.map((v) => v.version)) : null;
        return { _max: { version: max } };
      },
    },
    passwordFolder: {
      async findFirst(args: { where: Prisma.PasswordFolderWhereInput }) {
        return folders.find((f) => matchFolder(f, args.where)) ?? null;
      },
      async findMany() {
        return folders;
      },
      async create() {
        throw new Error('not used');
      },
      async updateMany(args: {
        where: Prisma.PasswordFolderWhereInput;
        data: Partial<PasswordFolder>;
      }) {
        let count = 0;
        for (const row of folders) {
          if (matchFolder(row, args.where)) {
            Object.assign(row, args.data, { updatedAt: new Date() });
            count += 1;
          }
        }
        return { count };
      },
      async findFirstOrThrow(args: { where: Prisma.PasswordFolderWhereInput }) {
        const row = folders.find((f) => matchFolder(f, args.where));
        if (!row) throw new Error('not found');
        return row;
      },
      async count() {
        return 0;
      },
    },
    user: {
      async findMany(args?: { where?: Record<string, unknown> }) {
        const where = args?.where ?? {};
        if (where.role === 'SUPER_ADMIN') {
          return accessUsers.filter(
            (u) => u.isActive !== false && u.role === 'SUPER_ADMIN',
          );
        }
        if (where.role === 'OPERATOR' && where.globalAccess) {
          return accessUsers.filter(
            (u) =>
              u.isActive !== false &&
              u.role === 'OPERATOR' &&
              (u.globalAccess === 'FULL' || u.globalAccess === 'READONLY'),
          );
        }
        return [];
      },
    },
    membership: {
      async findMany() {
        return accessUsers
          .filter(
            (u) =>
              u.isActive !== false &&
              (u.role === 'OPERATOR' || u.role === 'CONTRACTOR'),
          )
          .map((user) => ({ user }));
      },
    },
    asset: {
      async findFirst() {
        return { id: 'asset-existing' };
      },
    },
  };

  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const crypto = {
    encrypt: jest.fn((v: string) => `ENC(${v})`),
    decrypt: jest.fn((blob: string) =>
      blob.startsWith('ENC(') ? blob.slice(4, -1) : blob,
    ),
    reencryptIfStale: jest.fn(),
  };
  const env = { values: { HIBP_ENABLED: false } };
  const queues = { enqueuePwnedCheck: jest.fn().mockResolvedValue('job-1') };
  const stars = { isStarred: jest.fn().mockResolvedValue(false) };

  const svc = new PasswordsService(
    prisma as never,
    audit as never,
    crypto as never,
    env as never,
    queues as never,
    stars as never,
  );

  return { svc, prisma, passwords, versions, audit, crypto, queues, stars };
}

const META = { ip: '127.0.0.1', userAgent: 'jest' };
const OPERATOR: AuthedUser = {
  id: 'user-op',
  email: 'op@acme.test',
  role: 'OPERATOR',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: 'sess-op',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
  passwordAccess: FULL_PASSWORD_ACCESS,
};
const OTHER_OPERATOR: AuthedUser = {
  ...OPERATOR,
  id: 'user-op2',
  email: 'op2@acme.test',
  sessionId: 'sess-op2',
};
const MEMBERSHIP_MANAGER: AuthedUser = {
  ...OPERATOR,
  id: 'user-manager',
  email: 'manager@acme.test',
  platformCapabilities: ['MEMBERSHIP_MANAGE'],
  sessionId: 'sess-manager',
};
const SUPER: AuthedUser = {
  ...OPERATOR,
  id: 'user-root',
  role: 'SUPER_ADMIN',
  globalAccess: null,
  platformCapabilities: [],
  sessionId: 'sess-root',
};
const CLIENT: AuthedUser = {
  ...OPERATOR,
  id: 'user-client',
  role: 'CLIENT_USER',
  globalAccess: null,
  platformCapabilities: [],
  sessionId: 'sess-client',
};

describe('PasswordsService — list', () => {
  it('scopes by company and hides rows from other tenants', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-a', companyId: 'co-1', name: 'A' }),
        passwordRow({ id: 'pwd-b', companyId: 'co-2', name: 'B' }),
      ],
    });

    const list = await svc.list(OPERATOR, 'co-1', {});
    expect(list.map((p) => p.id)).toEqual(['pwd-a']);
  });

  it('CLIENT_USER only sees visibleToClients=true rows', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-a', visibleToClients: true }),
        passwordRow({ id: 'pwd-b', visibleToClients: false }),
      ],
    });

    const list = await svc.list(CLIENT, 'co-1', {});
    expect(list.map((p) => p.id)).toEqual(['pwd-a']);
  });

  it('filters internally restricted rows for non-allowlisted internal users', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-a', restrictedToUserIds: ['user-op'] }),
        passwordRow({ id: 'pwd-b', restrictedToUserIds: ['someone-else'] }),
        passwordRow({ id: 'pwd-c', restrictedToUserIds: [] }),
      ],
    });

    const list = await svc.list(OPERATOR, 'co-1', {});
    expect(list.map((p) => p.id)).toEqual(['pwd-a', 'pwd-c']);
  });

  it('does not apply internal restrictions to CLIENT_USER portal reads', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          visibleToClients: true,
          restrictedToUserIds: ['someone-else'],
        }),
      ],
    });

    const list = await svc.list(CLIENT, 'co-1', {});
    expect(list.map((p) => p.id)).toEqual(['pwd-a']);
    expect(list[0]?.restrictedToUserIds).toEqual([]);
  });

  it('includes restricted + client-hidden rows for SUPER_ADMIN', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-a', restrictedToUserIds: ['someone-else'] }),
        passwordRow({ id: 'pwd-b', visibleToClients: false }),
      ],
    });

    const list = await svc.list(SUPER, 'co-1', {});
    expect(list.map((p) => p.id).sort()).toEqual(['pwd-a', 'pwd-b']);
  });
});

describe('PasswordsService — global password access policy (issue #110)', () => {
  const OUTSIDER: AuthedUser = { ...OPERATOR, passwordAccess: NO_PASSWORD_ACCESS };
  const OUTSIDE_MANAGER: AuthedUser = { ...MEMBERSHIP_MANAGER, passwordAccess: NO_PASSWORD_ACCESS };

  function stubs() {
    return makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-open', restrictedToUserIds: [], passwordCiphertext: 'ENC(open)' }),
        passwordRow({ id: 'pwd-mine', restrictedToUserIds: ['user-op'], passwordCiphertext: 'ENC(mine)' }),
        passwordRow({ id: 'pwd-theirs', restrictedToUserIds: ['someone-else'] }),
      ],
      accessUsers: [
        { id: 'user-op', email: 'op@acme.test', name: 'Operator', role: 'OPERATOR' },
        { id: 'user-manager', email: 'manager@acme.test', name: 'Manager', role: 'OPERATOR' },
      ],
    });
  }

  it('lists only own-list entries for a user outside the policy', async () => {
    const { svc } = stubs();
    const list = await svc.list(OUTSIDER, 'co-1', {});
    expect(list.map((p) => p.id)).toEqual(['pwd-mine']);
  });

  it('refuses detail and reveal of an entry without own list, but allows an own-list grant', async () => {
    const { svc } = stubs();
    await expect(svc.getDetail(OUTSIDER, 'co-1', 'pwd-open')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.reveal(OUTSIDER, 'co-1', 'pwd-open', {}, META)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.reveal(OUTSIDER, 'co-1', 'pwd-mine', {}, META)).resolves.toEqual({
      password: 'mine',
    });
  });

  it('keeps today\'s behaviour for a user inside the policy', async () => {
    const { svc } = stubs();
    const list = await svc.list(OPERATOR, 'co-1', {});
    expect(list.map((p) => p.id).sort()).toEqual(['pwd-mine', 'pwd-open']);
  });

  it('refuses to create an entry that would use the global policy', async () => {
    const { svc } = stubs();
    await expect(
      svc.create(OUTSIDER, 'co-1', { name: 'New', password: 'x' }, META),
    ).rejects.toThrow('You do not have password access');
    await expect(
      svc.create(OUTSIDE_MANAGER, 'co-1', { name: 'New', password: 'x', restrictedToUserIds: [] }, META),
    ).rejects.toThrow('You do not have password access');
  });

  it('lets a manager outside the policy create an entry with its own list', async () => {
    const { svc } = stubs();
    await expect(
      svc.create(
        OUTSIDE_MANAGER,
        'co-1',
        { name: 'New', password: 'x', restrictedToUserIds: ['user-manager'] },
        META,
      ),
    ).resolves.toMatchObject({ restrictedToUserIds: ['user-manager'] });
  });
});

describe('PasswordsService — detail', () => {
  it('CLIENT_USER gets 404 on internal rows', async () => {
    const { svc } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a', visibleToClients: false })],
    });

    await expect(svc.getDetail(CLIENT, 'co-1', 'pwd-a')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('decrypts notes for admin readers', async () => {
    const { svc, crypto } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          notesCiphertext: 'ENC(Rack 4, top shelf)',
        }),
      ],
    });

    const detail = await svc.getDetail(OPERATOR, 'co-1', 'pwd-a');
    expect(detail.notes).toBe('Rack 4, top shelf');
    expect(crypto.decrypt).toHaveBeenCalledWith(
      'ENC(Rack 4, top shelf)',
      passwordVaultAad('co-1', 'pwd-a', 'notes'),
    );
  });

  it('withholds notes from an API key not minted with allowPasswordReveal', async () => {
    // Notes are vault-encrypted (recovery codes, PINs). Returning them to a
    // default key would make the reveal gate a GET away from bypassed.
    const rows = () => [
      passwordRow({ id: 'pwd-a', notesCiphertext: 'ENC(door code 4471)' }),
    ];
    const plain = makeStubs({ passwords: rows() });
    const keyed = { ...OPERATOR, apiKeyId: 'k-1', apiKeyAllowPasswordReveal: false };
    expect((await plain.svc.getDetail(keyed, 'co-1', 'pwd-a')).notes).toBeNull();
    expect(plain.crypto.decrypt).not.toHaveBeenCalled();

    const opted = makeStubs({ passwords: rows() });
    const revealKey = { ...OPERATOR, apiKeyId: 'k-2', apiKeyAllowPasswordReveal: true };
    // Notes are returned as stored plain text.
    expect((await opted.svc.getDetail(revealKey, 'co-1', 'pwd-a')).notes).toBe('door code 4471');
  });

  it('returns any stored JSON-looking note as its text, never parsed', async () => {
    const stored = '{"type":"doc","content":[{"type":"paragraph"}]}';
    const { svc } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a', notesCiphertext: `ENC(${stored})` })],
    });

    const detail = await svc.getDetail(OPERATOR, 'co-1', 'pwd-a');
    expect(detail.notes).toBe(stored);
  });

  it.each([
    '1234',
    'true',
    'null',
    '"hello"',
    '[1,2]',
    '{"a":1}',
    'Door code is 4471, alarm panel is behind the server rack.',
  ])('round-trips the plain-text note %s as the exact original string', async (note) => {
    const { svc } = makeStubs();

    const created = await svc.create(
      OPERATOR,
      'co-1',
      { name: 'Text note', password: 'super-secret', notes: note },
      META,
    );

    const detail = await svc.getDetail(OPERATOR, 'co-1', created.id);
    expect(detail.notes).toBe(note);
  });

  it('returns a JSON-shaped plain-text note verbatim in the update response', async () => {
    const { svc } = makeStubs({ passwords: [passwordRow({ id: 'pwd-a' })] });

    const updated = await svc.update(OPERATOR, 'co-1', 'pwd-a', { notes: '1234' }, META);
    expect(updated.notes).toBe('1234');
  });

  it('returns null without logging the note when notes fail to decrypt', async () => {
    const { svc, crypto } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a', notesCiphertext: 'v9:opaque-notes-blob' })],
    });
    crypto.decrypt.mockImplementationOnce(() => {
      throw new Error('unknown key id');
    });
    const logError = jest
      .spyOn((svc as unknown as { logger: { error: (m: string) => void } }).logger, 'error')
      .mockImplementation(() => undefined);

    const detail = await svc.getDetail(OPERATOR, 'co-1', 'pwd-a');
    expect(detail.notes).toBeNull();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0]?.[0])).not.toContain('opaque-notes-blob');
  });

  it('denies internal detail reads outside the allow-list', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          restrictedToUserIds: ['user-op'],
        }),
      ],
    });

    await expect(svc.getDetail(OTHER_OPERATOR, 'co-1', 'pwd-a')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows CLIENT_USER detail reads for visible restricted credentials', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          visibleToClients: true,
          restrictedToUserIds: ['someone-else'],
        }),
      ],
    });

    const detail = await svc.getDetail(CLIENT, 'co-1', 'pwd-a');
    expect(detail.id).toBe('pwd-a');
    expect(detail.restrictedToUserIds).toEqual([]);
  });
});

describe('PasswordsService — listVersions', () => {
  it('enforces the internal allow-list before returning history', async () => {
    const { svc, versions } = makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-a', restrictedToUserIds: ['user-op'] }),
      ],
    });
    versions.push({
      id: 'pv-1',
      passwordId: 'pwd-a',
      companyId: 'co-1',
      version: 1,
      changedFields: ['password'],
      changedBy: 'user-op',
      changeReason: null,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    } as unknown as StoredVersion);

    // Non-allow-listed operator can't even enumerate the version history.
    await expect(
      svc.listVersions(OTHER_OPERATOR, 'co-1', 'pwd-a'),
    ).rejects.toThrow(ForbiddenException);

    // Allow-listed operator gets the rows.
    const rows = await svc.listVersions(OPERATOR, 'co-1', 'pwd-a');
    expect(rows.map((r) => r.version)).toEqual([1]);
  });
});

describe('PasswordsService — create / update', () => {
  it('defaults new passwords to internal/private when omitted', async () => {
    const { svc } = makeStubs();

    const created = await svc.create(
      OPERATOR,
      'co-1',
      { name: 'Portal VPN', password: 'super-secret' },
      META,
    );

    // Secure-by-default: omitting visibleToClients must NOT expose the
    // credential to the client portal (WS-003).
    expect(created.visibleToClients).toBe(false);
  });

  it('honors an explicit visibleToClients=true opt-in', async () => {
    const { svc } = makeStubs();

    const created = await svc.create(
      OPERATOR,
      'co-1',
      { name: 'Portal VPN', password: 'super-secret', visibleToClients: true },
      META,
    );

    expect(created.visibleToClients).toBe(true);
  });

  it('requires MEMBERSHIP_MANAGE to update internal access', async () => {
    const { svc } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a' })],
      accessUsers: [
        {
          id: 'user-op',
          email: 'op@acme.test',
          name: 'Operator',
          role: 'OPERATOR',
        },
      ],
    });

    await expect(
      svc.update(
        OPERATOR,
        'co-1',
        'pwd-a',
        { restrictedToUserIds: ['user-op'] },
        META,
      ),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      svc.update(
        MEMBERSHIP_MANAGER,
        'co-1',
        'pwd-a',
        { restrictedToUserIds: ['user-op'] },
        META,
      ),
    ).resolves.toMatchObject({ restrictedToUserIds: ['user-op'] });
  });

  it('normalizes restricted saves to include active super admins', async () => {
    const { svc } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a' })],
      accessUsers: [
        {
          id: 'user-root',
          email: 'root@acme.test',
          name: 'Root',
          role: 'SUPER_ADMIN',
        },
        {
          id: 'user-op',
          email: 'op@acme.test',
          name: 'Operator',
          role: 'OPERATOR',
        },
      ],
    });

    const users = await svc.listInternalAccessUsers('co-1');
    expect(users[0]).toMatchObject({
      id: 'user-root',
      role: 'SUPER_ADMIN',
      alwaysIncluded: true,
      accessSource: 'super_admin',
    });

    await expect(
      svc.update(
        MEMBERSHIP_MANAGER,
        'co-1',
        'pwd-a',
        { restrictedToUserIds: ['user-op'] },
        META,
      ),
    ).resolves.toMatchObject({
      restrictedToUserIds: ['user-op', 'user-root'],
    });
  });
});

describe('PasswordsService — archive / restore', () => {
  it('round-trips archivedAt and writes one audit row each', async () => {
    const { svc, passwords, audit } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a' })],
    });

    await svc.archive(OPERATOR, 'co-1', 'pwd-a', META);
    expect(passwords[0]?.archivedAt).not.toBeNull();

    await svc.restore(OPERATOR, 'co-1', 'pwd-a', META);
    expect(passwords[0]?.archivedAt).toBeNull();

    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toContain('password.archived');
    expect(actions).toContain('password.restored');
  });

  it('rejects archiving an already-archived password', async () => {
    const { svc } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a', archivedAt: now(-1000) })],
    });

    await expect(svc.archive(OPERATOR, 'co-1', 'pwd-a', META)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('PasswordsService — reveal', () => {
  it('returns decrypted password + writes audit', async () => {
    const { svc, audit } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          passwordCiphertext: 'ENC(hunter2)',
        }),
      ],
    });

    const out = await svc.reveal(OPERATOR, 'co-1', 'pwd-a', {}, META);
    expect(out).toEqual({ password: 'hunter2' });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0]?.[0].action).toBe('password.revealed');
  });

  it('requires a reason when requireReasonToView=true', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-a', requireReasonToView: true }),
      ],
    });

    await expect(
      svc.reveal(OPERATOR, 'co-1', 'pwd-a', {}, META),
    ).rejects.toThrow(BadRequestException);

    // With a reason, reveal succeeds.
    const ok = await svc.reveal(
      OPERATOR,
      'co-1',
      'pwd-a',
      { reason: 'ticket #1234' },
      META,
    );
    expect(ok.password).toBe('super-secret');
  });

  it('enforces restrictedToUserIds', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          restrictedToUserIds: ['user-op'],
        }),
      ],
    });

    await expect(
      svc.reveal(OTHER_OPERATOR, 'co-1', 'pwd-a', {}, META),
    ).rejects.toThrow(ForbiddenException);

    // Allow-listed user succeeds.
    await expect(
      svc.reveal(OPERATOR, 'co-1', 'pwd-a', {}, META),
    ).resolves.toBeDefined();

    // SUPER_ADMIN bypasses restriction.
    await expect(
      svc.reveal(SUPER, 'co-1', 'pwd-a', {}, META),
    ).resolves.toBeDefined();
  });

  it('returns 404 for CLIENT_USER when not client-visible', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-a', visibleToClients: false }),
      ],
    });

    await expect(
      svc.reveal(CLIENT, 'co-1', 'pwd-a', {}, META),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses to reveal an archived password', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-a', archivedAt: now(-1000) }),
      ],
    });

    await expect(
      svc.reveal(OPERATOR, 'co-1', 'pwd-a', {}, META),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('PasswordsService — revealVersion / generateTotpCode', () => {
  it('revealVersion enforces the internal allow-list', async () => {
    const { svc, versions } = makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-a', restrictedToUserIds: ['user-op'] }),
      ],
    });
    versions.push({
      id: 'pv-1',
      passwordId: 'pwd-a',
      companyId: 'co-1',
      version: 1,
      changedFields: ['password'],
      changedBy: 'user-op',
      changeReason: null,
      passwordCiphertext: 'ENC(old-secret)',
      notesCiphertext: null,
      totpSecretCiphertext: null,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    } as unknown as StoredVersion);

    // Non-allow-listed operator is denied before any ciphertext is read.
    await expect(
      svc.revealVersion(OTHER_OPERATOR, 'co-1', 'pwd-a', 1, {}, META),
    ).rejects.toThrow(ForbiddenException);

    // SUPER_ADMIN bypasses the restriction and gets the historical secret.
    const out = await svc.revealVersion(SUPER, 'co-1', 'pwd-a', 1, {}, META);
    expect(out.password).toBe('old-secret');
  });

  it('restoreVersion keeps a JSON-shaped plain-text note verbatim', async () => {
    const { svc, versions, passwords } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a', notesCiphertext: 'ENC(current)' })],
    });
    versions.push({
      id: 'pv-1',
      passwordId: 'pwd-a',
      companyId: 'co-1',
      version: 1,
      changedFields: ['notes'],
      changedBy: 'user-op',
      changeReason: null,
      passwordCiphertext: 'ENC(old-secret)',
      notesCiphertext: 'ENC("hello")',
      totpSecretCiphertext: null,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    } as unknown as StoredVersion);

    const restored = await svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META);
    expect(restored.notes).toBe('"hello"');
    // Re-encrypted as the same string — not unquoted to `hello`.
    expect(passwords[0]?.notesCiphertext).toBe('ENC("hello")');
  });

  it('generateTotpCode enforces the allow-list and client visibility', async () => {
    const { svc } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-restricted',
          restrictedToUserIds: ['user-op'],
          totpSecretCiphertext: 'ENC(JBSWY3DPEHPK3PXP)',
        }),
        passwordRow({
          id: 'pwd-internal',
          visibleToClients: false,
          totpSecretCiphertext: 'ENC(JBSWY3DPEHPK3PXP)',
        }),
      ],
    });

    // Non-allow-listed operator → 403 (before the TOTP secret is touched).
    await expect(
      svc.generateTotpCode(OTHER_OPERATOR, 'co-1', 'pwd-restricted'),
    ).rejects.toThrow(ForbiddenException);

    // CLIENT_USER on an internal (non-client-visible) row → 404, so
    // existence stays hidden.
    await expect(
      svc.generateTotpCode(CLIENT, 'co-1', 'pwd-internal'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('PasswordsService — cascade archive from asset', () => {
  it('archives only active linked rows for the target asset', async () => {
    const { svc, passwords } = makeStubs({
      passwords: [
        passwordRow({ id: 'pwd-a', assetId: 'asset-1' }),
        passwordRow({ id: 'pwd-b', assetId: 'asset-1', archivedAt: now(-1000) }),
        passwordRow({ id: 'pwd-c', assetId: 'asset-2' }),
        passwordRow({ id: 'pwd-d', assetId: null }),
      ],
    });

    const archivedAt = new Date();
    const { archived } = await svc.cascadeArchiveFromAsset(
      'co-1',
      'asset-1',
      archivedAt,
    );

    expect(archived).toBe(1);
    expect(passwords.find((p) => p.id === 'pwd-a')?.archivedAt).toEqual(
      archivedAt,
    );
    expect(passwords.find((p) => p.id === 'pwd-c')?.archivedAt).toBeNull();
    expect(passwords.find((p) => p.id === 'pwd-d')?.archivedAt).toBeNull();
  });
});

describe('PasswordsService — updateFolder parent scoping', () => {
  it('rejects a parentId belonging to another company', async () => {
    const { svc } = makeStubs({
      folders: [
        folderRow({ id: 'fld-mine', companyId: 'co-1' }),
        folderRow({ id: 'fld-foreign', companyId: 'co-2' }),
      ],
    });

    await expect(
      svc.updateFolder(
        OPERATOR,
        'co-1',
        'fld-mine',
        { parentId: 'fld-foreign' },
        META,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an archived parent', async () => {
    const { svc } = makeStubs({
      folders: [
        folderRow({ id: 'fld-mine', companyId: 'co-1' }),
        folderRow({ id: 'fld-old', companyId: 'co-1', archivedAt: new Date() }),
      ],
    });

    await expect(
      svc.updateFolder(
        OPERATOR,
        'co-1',
        'fld-mine',
        { parentId: 'fld-old' },
        META,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts a same-company parent and clears the parent with null', async () => {
    const { svc } = makeStubs({
      folders: [
        folderRow({ id: 'fld-parent', companyId: 'co-1' }),
        folderRow({ id: 'fld-child', companyId: 'co-1' }),
      ],
    });

    const moved = await svc.updateFolder(
      OPERATOR,
      'co-1',
      'fld-child',
      { parentId: 'fld-parent' },
      META,
    );
    expect(moved.parentId).toBe('fld-parent');

    const cleared = await svc.updateFolder(
      OPERATOR,
      'co-1',
      'fld-child',
      { parentId: null },
      META,
    );
    expect(cleared.parentId).toBeNull();
  });
});

function versionRow(init: Partial<PasswordVersion> & { version: number }): StoredVersion {
  return {
    id: `pv-seed-${init.version}`,
    passwordId: 'pwd-a',
    companyId: 'co-1',
    name: 'Acme VPN',
    username: 'ops@acme.test',
    url: 'https://vpn.acme.test',
    notesCiphertext: null,
    passwordCiphertext: 'ENC(old-secret)',
    totpSecretCiphertext: null,
    totpAlgorithm: 'SHA1',
    totpDigits: 6,
    totpPeriod: 30,
    changedFields: ['username'],
    changedBy: 'user-op',
    changeReason: null,
    createdAt: new Date('2026-01-02T00:00:00Z'),
    ...init,
  } as unknown as StoredVersion;
}

describe('PasswordsService — listVersions captured fields', () => {
  it('returns name/username/url per version and never ciphertext', async () => {
    const { svc, versions } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a' })],
    });
    versions.push(
      versionRow({
        version: 1,
        name: 'Old name',
        username: 'old@example.test',
        url: null,
        notesCiphertext: 'ENC(secret note)',
        totpSecretCiphertext: 'ENC(JBSWY3DPEHPK3PXP)',
      }),
    );
    const [row] = await svc.listVersions(OPERATOR, 'co-1', 'pwd-a');
    expect(row).toMatchObject({
      version: 1,
      name: 'Old name',
      username: 'old@example.test',
      url: null,
    });
    const json = JSON.stringify(row);
    expect(json).not.toContain('Ciphertext');
    expect(json).not.toContain('old-secret');
    expect(json).not.toContain('secret note');
    expect(json).not.toContain('JBSWY3DPEHPK3PXP');
    expect(Object.keys(row ?? {})).not.toContain('notes');
  });

  it('withholds the captured name/username/url from CLIENT_USER (portal) reads', async () => {
    // A credential shared with the client portal may have had a different
    // name, username or URL before it was shared. The history metadata
    // (who/when/which fields) stays visible, as before; the captured values
    // are internal-only.
    const { svc, versions } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a', visibleToClients: true })],
    });
    versions.push(
      versionRow({
        version: 1,
        name: 'Internal name',
        username: 'internal-admin@example.test',
        url: 'https://internal.example.test',
      }),
    );
    const [row] = await svc.listVersions(CLIENT, 'co-1', 'pwd-a');
    expect(row).toMatchObject({ version: 1 });
    expect(row).not.toHaveProperty('name');
    expect(row).not.toHaveProperty('username');
    expect(row).not.toHaveProperty('url');
    const json = JSON.stringify(row);
    expect(json).not.toContain('Internal name');
    expect(json).not.toContain('internal-admin@example.test');
    expect(json).not.toContain('internal.example.test');
  });
});

describe('PasswordsService — update flags only real changes', () => {
  it('does not flag notes/password/totp that are re-sent unchanged', async () => {
    const { svc, versions } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          notesCiphertext: 'ENC(same note)',
          totpSecretCiphertext: 'ENC(JBSWY3DPEHPK3PXP)',
        }),
      ],
    });
    await svc.update(
      OPERATOR,
      'co-1',
      'pwd-a',
      {
        username: 'new@acme.test',
        password: 'super-secret',
        notes: 'same note',
        totp: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
      },
      META,
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.changedFields).toEqual(['username']);
  });

  it('re-scores strength when an unchanged password is sent with a new username', async () => {
    const { svc, passwords, versions } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a', passwordStrength: 4 })],
    });
    const rotatedBefore = passwords[0]?.lastRotatedAt;
    await svc.update(
      OPERATOR,
      'co-1',
      'pwd-a',
      { username: 'super-secret', password: 'super-secret' },
      META,
    );
    expect(versions[0]?.changedFields).toEqual(['username']);
    expect(passwords[0]?.lastRotatedAt).toEqual(rotatedBefore);
    expect(passwords[0]?.passwordStrength).toBe(
      computePasswordStrength('super-secret', ['Acme VPN', 'super-secret', 'https://vpn.acme.test']),
    );
    expect(passwords[0]?.passwordStrength).not.toBe(4);
  });

  it('writes no version at all when every sent field is unchanged', async () => {
    const { svc, versions, passwords } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a', notesCiphertext: 'ENC(same note)' })],
    });
    const before = { ...passwords[0] };
    await svc.update(
      OPERATOR,
      'co-1',
      'pwd-a',
      { password: 'super-secret', notes: 'same note', totp: null },
      META,
    );
    expect(versions).toHaveLength(0);
    expect(passwords[0]?.passwordCiphertext).toBe(before.passwordCiphertext);
    expect(passwords[0]?.lastRotatedAt).toEqual(before.lastRotatedAt);
  });

  it('treats empty-string and null notes as the same "no notes"', async () => {
    const { svc, versions } = makeStubs({ passwords: [passwordRow({ id: 'pwd-a' })] });
    await svc.update(OPERATOR, 'co-1', 'pwd-a', { notes: '' }, META);
    await svc.update(OPERATOR, 'co-1', 'pwd-a', { notes: null }, META);
    expect(versions).toHaveLength(0);
  });

  it('still flags notes, password and totp parts that truly differ', async () => {
    const { svc, versions } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          notesCiphertext: 'ENC(old note)',
          totpSecretCiphertext: 'ENC(JBSWY3DPEHPK3PXP)',
        }),
      ],
    });
    await svc.update(
      OPERATOR,
      'co-1',
      'pwd-a',
      {
        password: 'a-different-secret',
        notes: 'new note',
        totp: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 30 },
      },
      META,
    );
    expect(versions[0]?.changedFields).toEqual([
      'password',
      'notes',
      'totpAlgorithm',
      'totpDigits',
    ]);
  });

  it('clearing a TOTP secret that does not exist is a no-op', async () => {
    const { svc, versions } = makeStubs({ passwords: [passwordRow({ id: 'pwd-a' })] });
    await svc.update(OPERATOR, 'co-1', 'pwd-a', { totp: null }, META);
    expect(versions).toHaveLength(0);
  });
});

describe('PasswordsService — secret comparison is gated on reveal', () => {
  // A write-only API key must not learn whether a guessed secret matches
  // the stored one, so for it a sent secret always counts as changed and
  // the stored secret is never decrypted for a comparison.
  const WRITE_ONLY_KEY: AuthedUser = {
    ...OPERATOR,
    apiKeyId: 'key-1',
    apiKeyAllowWrite: true,
    apiKeyAllowPasswordReveal: false,
  };

  it('flags re-sent identical secrets as changed for a key without reveal', async () => {
    const { svc, versions, crypto } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          notesCiphertext: 'ENC(same note)',
          totpSecretCiphertext: 'ENC(JBSWY3DPEHPK3PXP)',
        }),
      ],
    });
    await svc.update(
      WRITE_ONLY_KEY,
      'co-1',
      'pwd-a',
      {
        password: 'super-secret',
        notes: 'same note',
        totp: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
      },
      META,
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.changedFields).toEqual(['password', 'notes', 'totpSecret']);
    expect(crypto.decrypt).not.toHaveBeenCalled();
  });

  it('does not compare the password or TOTP of a reason-to-view credential', async () => {
    const { svc, versions } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          requireReasonToView: true,
          notesCiphertext: 'ENC(same note)',
          totpSecretCiphertext: 'ENC(JBSWY3DPEHPK3PXP)',
        }),
      ],
    });
    await svc.update(
      OPERATOR,
      'co-1',
      'pwd-a',
      {
        password: 'super-secret',
        notes: 'same note',
        totp: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
      },
      META,
    );
    // Notes are readable without a reason, so they are still compared.
    expect(versions[0]?.changedFields).toEqual(['password', 'totpSecret']);
  });

  it('writes the whole TOTP block when only one parameter changed', async () => {
    const { svc, passwords, versions } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a', totpSecretCiphertext: 'ENC(JBSWY3DPEHPK3PXP)' })],
    });
    await svc.update(
      OPERATOR,
      'co-1',
      'pwd-a',
      { totp: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 6, period: 30 } },
      META,
    );
    expect(versions[0]?.changedFields).toEqual(['totpAlgorithm']);
    expect(passwords[0]?.totpSecretCiphertext).toBe('ENC(JBSWY3DPEHPK3PXP)');
    expect(passwords[0]?.totpAlgorithm).toBe('SHA256');
    expect(passwords[0]?.totpDigits).toBe(6);
    expect(passwords[0]?.totpPeriod).toBe(30);
  });

  it('still compares for a key minted with reveal', async () => {
    const { svc, versions } = makeStubs({
      passwords: [passwordRow({ id: 'pwd-a', notesCiphertext: 'ENC(same note)' })],
    });
    await svc.update(
      { ...WRITE_ONLY_KEY, apiKeyAllowPasswordReveal: true },
      'co-1',
      'pwd-a',
      { password: 'super-secret', notes: 'same note' },
      META,
    );
    expect(versions).toHaveLength(0);
  });
});

describe('PasswordsService — field-level restoreVersion', () => {
  function setup(extra: DeepPartial<Password> = {}) {
    const stubs = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          username: 'current@acme.test',
          passwordCiphertext: 'ENC(current-secret)',
          notesCiphertext: 'ENC(current note)',
          ...extra,
        }),
      ],
    });
    stubs.versions.push(
      versionRow({
        version: 1,
        name: 'Old name',
        username: 'old@acme.test',
        url: 'https://old.acme.test',
        notesCiphertext: 'ENC(old note)',
        passwordCiphertext: 'ENC(old-secret)',
      }),
    );
    return stubs;
  }

  it('restoring only the username leaves the password and everything else', async () => {
    const { svc, passwords, versions, audit } = setup();
    await svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META, ['username']);
    const row = passwords[0];
    expect(row?.username).toBe('old@acme.test');
    expect(row?.passwordCiphertext).toBe('ENC(current-secret)');
    expect(row?.notesCiphertext).toBe('ENC(current note)');
    expect(row?.name).toBe('Acme VPN');
    expect(row?.url).toBe('https://vpn.acme.test');
    const created = versions[versions.length - 1];
    expect(created?.changedFields).toEqual(['username']);
    expect(created?.changeReason).toBe('restore username from v1');
    // Audit carries field names only.
    const restoredCall = audit.log.mock.calls
      .map((c) => c[0] as { action: string; after: unknown })
      .find((c) => c.action === 'password.version.restored');
    expect(restoredCall?.after).toEqual({ fromVersion: 1, fields: ['username'] });
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('old@acme.test');
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('old-secret');
  });

  it('restores several chosen fields, including a secret, via update()', async () => {
    const { svc, passwords } = setup();
    await svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META, ['url', 'password']);
    expect(passwords[0]?.url).toBe('https://old.acme.test');
    expect(passwords[0]?.passwordCiphertext).toBe('ENC(old-secret)');
    expect(passwords[0]?.username).toBe('current@acme.test');
  });

  it('does not echo plaintext secrets in the response', async () => {
    const { svc } = setup();
    const out = await svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META, ['password']);
    expect(JSON.stringify(out)).not.toContain('old-secret');
    expect(JSON.stringify(out)).not.toContain('Ciphertext');
  });

  it('omitting fields keeps the whole-version behaviour', async () => {
    const { svc, passwords, audit } = setup();
    await svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META);
    const row = passwords[0];
    expect(row?.username).toBe('old@acme.test');
    expect(row?.name).toBe('Old name');
    expect(row?.passwordCiphertext).toBe('ENC(old-secret)');
    expect(row?.notesCiphertext).toBe('ENC(old note)');
    const restoredCall = audit.log.mock.calls
      .map((c) => c[0] as { action: string; after: unknown })
      .find((c) => c.action === 'password.version.restored');
    expect(restoredCall?.after).toEqual({ fromVersion: 1 });
  });

  it('refuses to restore notes it cannot decrypt instead of clearing them', async () => {
    const { svc, passwords, versions, crypto } = setup();
    versions[0]!.notesCiphertext = 'UNREADABLE';
    crypto.decrypt.mockImplementation((blob: string) => {
      if (blob === 'UNREADABLE') throw new Error('unknown kid');
      return blob.startsWith('ENC(') ? blob.slice(4, -1) : blob;
    });
    await expect(
      svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META, ['notes']),
    ).rejects.toThrow(BadRequestException);
    expect(passwords[0]?.notesCiphertext).toBe('ENC(current note)');
    expect(versions).toHaveLength(1);
  });

  it('reports a restore that changes nothing and does not audit it', async () => {
    const { svc, versions, audit } = setup({ username: 'old@acme.test' });
    await expect(
      svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META, ['username']),
    ).rejects.toThrow(/Nothing to restore/);
    expect(versions).toHaveLength(1);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('rejects unknown or empty field lists before changing anything', async () => {
    const { svc, passwords } = setup();
    await expect(
      svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META, [
        'color' as unknown as 'username',
      ]),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META, []),
    ).rejects.toThrow(BadRequestException);
    expect(passwords[0]?.username).toBe('current@acme.test');
  });

  it('refuses an archived password', async () => {
    const { svc } = setup({ archivedAt: new Date('2026-02-01T00:00:00Z') });
    await expect(
      svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META, ['username']),
    ).rejects.toThrow(BadRequestException);
  });

  it('404s on an unknown version and 403s for a non-allow-listed operator', async () => {
    const { svc } = setup({ restrictedToUserIds: ['user-op'] });
    await expect(
      svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 9, META, ['username']),
    ).rejects.toThrow(NotFoundException);
    await expect(
      svc.restoreVersion(OTHER_OPERATOR, 'co-1', 'pwd-a', 1, META, ['username']),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('PasswordsService — strength context and restore races', () => {
  const WRITE_ONLY_KEY: AuthedUser = {
    ...OPERATOR,
    apiKeyId: 'key-1',
    apiKeyAllowWrite: true,
    apiKeyAllowPasswordReveal: false,
  };

  function setup(extra: DeepPartial<Password> = {}) {
    const stubs = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          username: 'current@acme.test',
          passwordCiphertext: 'ENC(current-secret)',
          passwordStrength: 4,
          ...extra,
        }),
      ],
    });
    stubs.versions.push(
      versionRow({
        version: 1,
        username: 'current-secret',
        passwordCiphertext: 'ENC(old-secret)',
      }),
    );
    return stubs;
  }

  it('re-scores the stored password when only the username is restored', async () => {
    const { svc, passwords } = setup();
    await svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META, ['username']);
    expect(passwords[0]?.passwordStrength).toBe(
      computePasswordStrength('current-secret', [
        'Acme VPN',
        'current-secret',
        'https://vpn.acme.test',
      ]),
    );
    expect(passwords[0]?.passwordStrength).not.toBe(4);
  });

  it('scores a cleared username as empty, not as the old value', async () => {
    const { svc, passwords } = setup({ username: 'current-secret', passwordStrength: 0 });
    await svc.update(OPERATOR, 'co-1', 'pwd-a', { username: null }, META);
    expect(passwords[0]?.username).toBeNull();
    expect(passwords[0]?.passwordStrength).toBe(
      computePasswordStrength('current-secret', ['Acme VPN', '', 'https://vpn.acme.test']),
    );
  });

  it('does not re-score for a key without reveal, so the score is no oracle', async () => {
    const { svc, passwords, crypto } = setup();
    await svc.update(WRITE_ONLY_KEY, 'co-1', 'pwd-a', { username: 'current-secret' }, META);
    expect(passwords[0]?.username).toBe('current-secret');
    expect(passwords[0]?.passwordStrength).toBe(4);
    expect(crypto.decrypt).not.toHaveBeenCalled();
  });

  it('refuses a password-only restore to a caller who may not reveal it', async () => {
    const { svc, passwords } = setup();
    await expect(
      svc.restoreVersion(WRITE_ONLY_KEY, 'co-1', 'pwd-a', 1, META, ['password']),
    ).rejects.toThrow(ForbiddenException);
    expect(passwords[0]?.passwordCiphertext).toBe('ENC(current-secret)');
    // The whole-version restore scores against the version's own values.
    await svc.restoreVersion(WRITE_ONLY_KEY, 'co-1', 'pwd-a', 1, META);
    expect(passwords[0]?.passwordCiphertext).toBe('ENC(old-secret)');
  });

  it('refuses a password-only restore on a reason-to-view credential', async () => {
    const { svc } = setup({ requireReasonToView: true });
    await expect(
      svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META, ['password']),
    ).rejects.toThrow(ForbiddenException);
  });

  it('fails a restore that kept the password when the row changed meanwhile', async () => {
    const { svc, passwords, versions, crypto } = makeStubs({
      passwords: [
        passwordRow({
          id: 'pwd-a',
          username: 'current@acme.test',
          passwordCiphertext: 'ENC(same-secret)',
        }),
      ],
    });
    versions.push(
      versionRow({
        version: 1,
        username: 'old@acme.test',
        passwordCiphertext: 'ENC(same-secret)',
      }),
    );
    const decrypt = crypto.decrypt.getMockImplementation()!;
    let calls = 0;
    crypto.decrypt.mockImplementation((blob: string) => {
      calls += 1;
      // Call 1 reads the version; call 2 is the comparison with the live
      // row. A rotation lands in between.
      if (calls === 2) {
        passwords[0] = {
          ...passwords[0]!,
          username: 'rotated@acme.test',
          passwordCiphertext: 'ENC(rotated-secret)',
          updatedAt: new Date(Date.now() + 60_000),
        };
      }
      return decrypt(blob);
    });
    await expect(
      svc.restoreVersion(OPERATOR, 'co-1', 'pwd-a', 1, META),
    ).rejects.toThrow(ConflictException);
    expect(passwords[0]?.username).toBe('rotated@acme.test');
    expect(passwords[0]?.passwordCiphertext).toBe('ENC(rotated-secret)');
    expect(versions).toHaveLength(1);
  });
});
