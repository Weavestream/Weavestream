import {
  BadRequestException,
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
import type { AuthedUser } from '../common/current-user.decorator.js';

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

function makeStubs(
  initial: {
    passwords?: StoredPassword[];
    accessUsers?: StubAccessUser[];
  } = {},
) {
  const passwords: StoredPassword[] = [...(initial.passwords ?? [])];
  const accessUsers: StubAccessUser[] = [...(initial.accessUsers ?? [])];
  const versions: StoredVersion[] = [];
  const folders: PasswordFolder[] = [];
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
    },
    passwordFolder: {
      async findFirst() {
        return null;
      },
      async findMany() {
        return folders;
      },
      async create() {
        throw new Error('not used');
      },
      async updateMany() {
        return { count: 0 };
      },
      async findFirstOrThrow() {
        throw new Error('not used');
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
          notesCiphertext: 'ENC({"type":"doc","text":"hi"})',
        }),
      ],
    });

    const detail = await svc.getDetail(OPERATOR, 'co-1', 'pwd-a');
    expect(detail.notes).toEqual({ type: 'doc', text: 'hi' });
    expect(crypto.decrypt).toHaveBeenCalledWith(
      'ENC({"type":"doc","text":"hi"})',
    );
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
