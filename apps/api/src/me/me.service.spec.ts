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
  email: 'a@x',
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};

const META = { ip: '127.0.0.1', userAgent: 'jest' };

function makePrisma(before: { uiTheme: string; uiAccent: string }) {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(before),
      update: jest.fn().mockImplementation(async ({ data }) => ({
        uiTheme: data.uiTheme ?? before.uiTheme,
        uiAccent: data.uiAccent ?? before.uiAccent,
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
    audit as never,
  );
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
    expect(out).toEqual({ uiTheme: 'dark', uiAccent: 'iris' });
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
    expect(entry.before).toEqual({ uiTheme: 'system', uiAccent: 'lime' });
    expect(entry.after).toEqual({ uiTheme: 'light', uiAccent: 'lime' });
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
    expect(out).toEqual({ uiTheme: 'dark', uiAccent: 'coral' });
  });
});
