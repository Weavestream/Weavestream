import { DEFAULT_PASSWORD_GENERATOR_DEFAULTS } from '@weavestream/shared';
import { SettingsService } from './settings.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * SettingsService covers the seed-on-read invariant, the in-process
 * cache, the audit trail on PATCH, and the possessive-null semantics.
 * All paths use a mocked PrismaService — we are not testing Prisma,
 * we are testing the service's branching.
 */

const ACTOR: AuthedUser = {
  id: 'actor-1',
  role: 'SUPER_ADMIN',
  email: 'a@x',
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};

const META = { ip: '127.0.0.1', userAgent: 'jest' };

const NOW = new Date('2026-04-20T00:00:00.000Z');

function baseRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'singleton',
    workspaceName: 'My Company',
    workspaceSubtitle: 'workspace',
    tenantTermSingular: 'Company',
    tenantTermPlural: 'Companies',
    tenantTermPossessive: null as string | null,
    updatedAt: NOW,
    updatedBy: null as string | null,
    ...overrides,
  };
}

function makePrisma() {
  return {
    systemSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
  };
}

function makeAudit() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

describe('SettingsService.get', () => {
  it('returns the singleton row as a DTO', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow());
    const svc = new SettingsService(prisma as never, makeAudit() as never);

    const out = await svc.get();

    expect(out).toEqual({
      workspaceName: 'My Company',
      workspaceSubtitle: 'workspace',
      tenantTermSingular: 'Company',
      tenantTermPlural: 'Companies',
      tenantTermPossessive: null,
      passwordGeneratorDefaults: DEFAULT_PASSWORD_GENERATOR_DEFAULTS,
      updatedAt: NOW.toISOString(),
    });
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('seeds the singleton when it is missing (self-healing read)', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(null);
    prisma.systemSetting.upsert.mockResolvedValue(baseRow());
    const svc = new SettingsService(prisma as never, makeAudit() as never);

    const out = await svc.get();

    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'singleton' },
        create: { id: 'singleton' },
        update: {},
      }),
    );
    expect(out.workspaceName).toBe('My Company');
  });

  it('caches within the TTL (no DB hit on second call)', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow());
    const svc = new SettingsService(prisma as never, makeAudit() as never);

    await svc.get();
    await svc.get();
    await svc.get();

    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsService.update', () => {
  it('applies partial updates, audits before/after, and busts the cache', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow());
    prisma.systemSetting.update.mockResolvedValue(
      baseRow({
        tenantTermSingular: 'Client',
        tenantTermPlural: 'Clients',
        tenantTermPossessive: "Client's",
      }),
    );
    const audit = makeAudit();
    const svc = new SettingsService(prisma as never, audit as never);

    // Warm the cache so we can observe the bust.
    prisma.systemSetting.findUnique.mockResolvedValueOnce(baseRow());
    await svc.get();
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);

    const result = await svc.update(
      ACTOR,
      {
        tenantTermSingular: 'Client',
        tenantTermPlural: 'Clients',
        tenantTermPossessive: "Client's",
      },
      META,
    );

    expect(prisma.systemSetting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'singleton' },
        data: expect.objectContaining({
          tenantTermSingular: 'Client',
          tenantTermPlural: 'Clients',
          tenantTermPossessive: "Client's",
          updatedBy: ACTOR.id,
        }),
      }),
    );
    expect(result.tenantTermSingular).toBe('Client');

    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0]![0];
    expect(entry.action).toBe('settings.update');
    expect(entry.entityType).toBe('SystemSetting');
    expect(entry.entityId).toBe('singleton');
    expect(entry.before).toEqual(
      expect.objectContaining({ tenantTermSingular: 'Company' }),
    );
    expect(entry.after).toEqual(
      expect.objectContaining({ tenantTermSingular: 'Client' }),
    );

    // Cache was busted — the next read hits Prisma again.
    const callsAfterUpdate = prisma.systemSetting.findUnique.mock.calls.length;
    prisma.systemSetting.findUnique.mockResolvedValueOnce(baseRow());
    await svc.get();
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(
      callsAfterUpdate + 1,
    );
  });

  it('accepts null to clear the possessive override', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(
      baseRow({ tenantTermPossessive: "Client's" }),
    );
    prisma.systemSetting.update.mockResolvedValue(
      baseRow({ tenantTermPossessive: null }),
    );
    const svc = new SettingsService(prisma as never, makeAudit() as never);

    const out = await svc.update(
      ACTOR,
      { tenantTermPossessive: null },
      META,
    );

    expect(prisma.systemSetting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantTermPossessive: null }),
      }),
    );
    expect(out.tenantTermPossessive).toBeNull();
  });

  it('omits fields that were not provided (partial update)', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow());
    prisma.systemSetting.update.mockResolvedValue(
      baseRow({ workspaceName: 'Acme IT' }),
    );
    const svc = new SettingsService(prisma as never, makeAudit() as never);

    await svc.update(ACTOR, { workspaceName: 'Acme IT' }, META);

    const dataArg = prisma.systemSetting.update.mock.calls[0]![0].data;
    expect(dataArg).toEqual({
      workspaceName: 'Acme IT',
      updatedBy: ACTOR.id,
    });
    expect(dataArg).not.toHaveProperty('tenantTermSingular');
    expect(dataArg).not.toHaveProperty('workspaceSubtitle');
  });
});
