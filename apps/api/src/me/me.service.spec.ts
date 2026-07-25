import { MeService } from './me.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Phase 9b.1 — MeService.updatePreferences audits before/after, writes
 * the DB enum (uppercase), and skips the audit write when the user
 * saves the exact same value they already had (no diff, no row).
 *
 * The Prisma client is mocked — we are not testing Prisma.
 */

const ACTOR: AuthedUser = {
  id: 'actor-1',
  role: 'OPERATOR',
  globalAccess: 'FULL',
  platformCapabilities: [],
  email: 'a@x',
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};

const META = { ip: '127.0.0.1', userAgent: 'jest' };

function makePrisma(before: {
  uiTheme: string;
  uiAccent: string;
  showItemCounts?: boolean;
}) {
  const row = { showItemCounts: false, ...before };
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockImplementation(async ({ data }) => ({
        uiTheme: data.uiTheme ?? row.uiTheme,
        uiAccent: data.uiAccent ?? row.uiAccent,
        showItemCounts: data.showItemCounts ?? row.showItemCounts,
      })),
    },
  };
}

function makeAudit() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function makeService(
  prisma: unknown,
  audit: unknown,
): MeService {
  // Password hash + cache services are irrelevant for updatePreferences,
  // but the constructor still requires them — stubs suffice.
  return new MeService(
    prisma as never,
    { verify: jest.fn(), hash: jest.fn() } as never,
    { replaceForUser: jest.fn() } as never,
    makeLockout() as never,
    audit as never,
  );
}

// Change-password lockout is irrelevant to updatePreferences /
// regenerateMfaBackupCodes; a permissive stub (never locked, no-op
// record/clear) satisfies the constructor.
function makeLockout(): unknown {
  return {
    isChangePasswordLocked: jest.fn().mockResolvedValue(false),
    recordChangePasswordFailure: jest.fn().mockResolvedValue(undefined),
    clearChangePasswordFailures: jest.fn().mockResolvedValue(undefined),
  };
}

describe('MeService.updatePreferences', () => {
  it('maps lowercase inputs to uppercase Prisma enums and returns lowercase', async () => {
    const prisma = makePrisma({ uiTheme: 'SYSTEM', uiAccent: 'LIME' });
    const audit = makeAudit();
    const svc = makeService(prisma, audit);

    const out = await svc.updatePreferences(
      ACTOR,
      { uiTheme: 'dark', uiAccent: 'iris' },
      META,
    );

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACTOR.id },
        data: { uiTheme: 'DARK', uiAccent: 'IRIS' },
      }),
    );
    expect(out).toEqual({
      uiTheme: 'dark',
      uiAccent: 'iris',
      showItemCounts: false,
    });
  });

  it('writes an audit entry with lowercase before/after diff', async () => {
    const prisma = makePrisma({ uiTheme: 'SYSTEM', uiAccent: 'LIME' });
    const audit = makeAudit();
    const svc = makeService(prisma, audit);

    await svc.updatePreferences(ACTOR, { uiTheme: 'light' }, META);

    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0]![0];
    expect(entry.action).toBe('user.preferences.update');
    expect(entry.entityType).toBe('User');
    expect(entry.entityId).toBe(ACTOR.id);
    expect(entry.before).toEqual({
      uiTheme: 'system',
      uiAccent: 'lime',
      showItemCounts: false,
    });
    expect(entry.after).toEqual({
      uiTheme: 'light',
      uiAccent: 'lime',
      showItemCounts: false,
    });
  });

  it('skips the audit write when the value is unchanged', async () => {
    const prisma = makePrisma({ uiTheme: 'DARK', uiAccent: 'TEAL' });
    const audit = makeAudit();
    const svc = makeService(prisma, audit);

    await svc.updatePreferences(
      ACTOR,
      { uiTheme: 'dark', uiAccent: 'teal' },
      META,
    );

    expect(audit.log).not.toHaveBeenCalled();
  });

  it('supports a partial update (theme only, accent left untouched)', async () => {
    const prisma = makePrisma({ uiTheme: 'SYSTEM', uiAccent: 'CORAL' });
    const audit = makeAudit();
    const svc = makeService(prisma, audit);

    const out = await svc.updatePreferences(ACTOR, { uiTheme: 'dark' }, META);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { uiTheme: 'DARK' },
      }),
    );
    expect(out).toEqual({
      uiTheme: 'dark',
      uiAccent: 'coral',
      showItemCounts: false,
    });
  });

  it('toggles showItemCounts on its own, leaving theme and accent alone', async () => {
    const prisma = makePrisma({
      uiTheme: 'DARK',
      uiAccent: 'TEAL',
      showItemCounts: false,
    });
    const audit = makeAudit();
    const svc = makeService(prisma, audit);

    const out = await svc.updatePreferences(
      ACTOR,
      { showItemCounts: true },
      META,
    );

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { showItemCounts: true } }),
    );
    expect(out).toEqual({
      uiTheme: 'dark',
      uiAccent: 'teal',
      showItemCounts: true,
    });
  });

  it('audits a counts-only change that leaves theme and accent identical', async () => {
    // The `changed` guard has to compare all three fields — comparing
    // only theme+accent would silently drop this write from the log.
    const prisma = makePrisma({
      uiTheme: 'DARK',
      uiAccent: 'TEAL',
      showItemCounts: false,
    });
    const audit = makeAudit();
    const svc = makeService(prisma, audit);

    await svc.updatePreferences(
      ACTOR,
      { uiTheme: 'dark', uiAccent: 'teal', showItemCounts: true },
      META,
    );

    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0]![0];
    expect(entry.before).toEqual({
      uiTheme: 'dark',
      uiAccent: 'teal',
      showItemCounts: false,
    });
    expect(entry.after).toEqual({
      uiTheme: 'dark',
      uiAccent: 'teal',
      showItemCounts: true,
    });
  });

  it('still skips the audit write when nothing at all changed', async () => {
    const prisma = makePrisma({
      uiTheme: 'DARK',
      uiAccent: 'TEAL',
      showItemCounts: true,
    });
    const audit = makeAudit();
    const svc = makeService(prisma, audit);

    await svc.updatePreferences(
      ACTOR,
      { uiTheme: 'dark', uiAccent: 'teal', showItemCounts: true },
      META,
    );

    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('MeService.changePassword', () => {
  function makeChangePasswordPrisma() {
    return {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: ACTOR.id, passwordHash: 'stored-hash' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) =>
        cb({
          user: { update: jest.fn().mockResolvedValue(undefined) },
          session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        }),
      ),
    };
  }

  it('rejects with 429 when the change-password lockout is engaged', async () => {
    const prisma = makeChangePasswordPrisma();
    const audit = makeAudit();
    const passwords = { verify: jest.fn(), hash: jest.fn() };
    const lockout = {
      isChangePasswordLocked: jest.fn().mockResolvedValue(true),
      recordChangePasswordFailure: jest.fn(),
      clearChangePasswordFailures: jest.fn(),
    };
    const svc = new MeService(
      prisma as never,
      passwords as never,
      { replaceForUser: jest.fn() } as never,
      lockout as never,
      audit as never,
    );

    await expect(
      svc.changePassword(
        ACTOR,
        { currentPassword: 'a', newPassword: 'b' } as never,
        META,
      ),
    ).rejects.toMatchObject({ status: 429 });
    // Short-circuits before touching the password or the DB.
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('records a failure and audits when the current password is wrong', async () => {
    const prisma = makeChangePasswordPrisma();
    const audit = makeAudit();
    const passwords = { verify: jest.fn().mockResolvedValue(false), hash: jest.fn() };
    const lockout = {
      isChangePasswordLocked: jest.fn().mockResolvedValue(false),
      recordChangePasswordFailure: jest.fn().mockResolvedValue(undefined),
      clearChangePasswordFailures: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new MeService(
      prisma as never,
      passwords as never,
      { replaceForUser: jest.fn() } as never,
      lockout as never,
      audit as never,
    );

    await expect(
      svc.changePassword(
        ACTOR,
        { currentPassword: 'wrong', newPassword: 'b' } as never,
        META,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(lockout.recordChangePasswordFailure).toHaveBeenCalledWith(ACTOR.id);
    expect(lockout.clearChangePasswordFailures).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.password.change.failed' }),
    );
  });

  it('clears failures on a successful change', async () => {
    const prisma = makeChangePasswordPrisma();
    const audit = makeAudit();
    const passwords = {
      verify: jest.fn().mockResolvedValue(true),
      hash: jest.fn().mockResolvedValue('new-hash'),
    };
    const lockout = {
      isChangePasswordLocked: jest.fn().mockResolvedValue(false),
      recordChangePasswordFailure: jest.fn().mockResolvedValue(undefined),
      clearChangePasswordFailures: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new MeService(
      prisma as never,
      passwords as never,
      { replaceForUser: jest.fn() } as never,
      lockout as never,
      audit as never,
    );

    const out = await svc.changePassword(
      ACTOR,
      { currentPassword: 'right', newPassword: 'different' } as never,
      META,
    );

    expect(out).toEqual({ ok: true });
    expect(lockout.clearChangePasswordFailures).toHaveBeenCalledWith(ACTOR.id);
    expect(lockout.recordChangePasswordFailure).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.password.change' }),
    );
  });
});

describe('MeService.regenerateMfaBackupCodes', () => {
  it('replaces existing codes and audits the one-time return', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          mfaEnabled: true,
          mfaEnforcementCompletedAt: new Date(),
        }),
      },
    };
    const backupCodes = {
      replaceForUser: jest.fn().mockResolvedValue(['AAAAA-BBBBB']),
    };
    const audit = makeAudit();
    const svc = new MeService(
      prisma as never,
      { verify: jest.fn(), hash: jest.fn() } as never,
      backupCodes as never,
      makeLockout() as never,
      audit as never,
    );

    const out = await svc.regenerateMfaBackupCodes(ACTOR, META);

    expect(out).toEqual({ backupCodes: ['AAAAA-BBBBB'] });
    expect(backupCodes.replaceForUser).toHaveBeenCalledWith(ACTOR.id);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.mfa.backup.regenerate',
        entityId: ACTOR.id,
        after: { count: 1 },
      }),
    );
  });
});
