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
  globalAccess: null,
  platformCapabilities: [],
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
    articleAutosaveEnabled: false,
    articleDefaultEditorMode: 'tiptap',
    apiKeysEnabled: false,
    updatedAt: NOW,
    updatedBy: null as string | null,
    ...overrides,
  };
}

/** Prisma stub whose interactive transaction runs against the same mocks. */
function makePrisma() {
  const prisma = {
    systemSetting: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(
      async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma),
    ),
  };
  return prisma;
}

function makeAudit() {
  return {
    log: jest.fn().mockResolvedValue(undefined),
    logWithClient: jest.fn().mockResolvedValue(undefined),
  };
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
      articleAutosaveEnabled: false,
      articleDefaultEditorMode: 'tiptap',
      apiKeysEnabled: false,
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
    prisma.systemSetting.findUniqueOrThrow.mockResolvedValue(baseRow());
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

    // The audit row is written with the transaction client, not after it.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
    expect(audit.logWithClient).toHaveBeenCalledTimes(1);
    expect(audit.logWithClient.mock.calls[0]![0]).toBe(prisma);
    const entry = audit.logWithClient.mock.calls[0]![1];
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
    prisma.systemSetting.findUniqueOrThrow.mockResolvedValue(
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
    prisma.systemSetting.findUniqueOrThrow.mockResolvedValue(baseRow());
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

  it('fails as a whole when the audit write fails, and drops the cache', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow());
    prisma.systemSetting.findUniqueOrThrow.mockResolvedValue(baseRow());
    prisma.systemSetting.update.mockResolvedValue(
      baseRow({ workspaceName: 'Acme IT' }),
    );
    const audit = makeAudit();
    audit.logWithClient.mockRejectedValueOnce(new Error('audit down'));
    const svc = new SettingsService(prisma as never, audit as never);

    await svc.get(); // warm the cache
    await expect(
      svc.update(ACTOR, { workspaceName: 'Acme IT' }, META),
    ).rejects.toThrow('audit down');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();

    // The transaction rolled back (Prisma's contract). The next read must
    // come from the database, not a cache that the failure left in place.
    const reads = prisma.systemSetting.findUnique.mock.calls.length;
    await svc.get();
    expect(prisma.systemSetting.findUnique.mock.calls.length).toBe(reads + 1);
  });
});

describe('SettingsService API key switch', () => {
  it('is off by default', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow());
    const svc = new SettingsService(prisma as never, makeAudit() as never);
    await expect(svc.apiKeysEnabled()).resolves.toBe(false);
  });

  it('writes and audits in one transaction, then drops the cache', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow());
    prisma.systemSetting.findUniqueOrThrow.mockResolvedValue({ apiKeysEnabled: false });
    prisma.systemSetting.update.mockResolvedValue(baseRow({ apiKeysEnabled: true }));
    const audit = makeAudit();
    const svc = new SettingsService(prisma as never, audit as never);

    await svc.apiKeysEnabled(); // warm the cache with "off"
    const out = await svc.setApiKeysEnabled(ACTOR, true, META);
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow({ apiKeysEnabled: true }));

    expect(out.apiKeysEnabled).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.systemSetting.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { apiKeysEnabled: true, updatedBy: 'actor-1' },
    });
    // The audit row is written with the transaction client, not after it.
    expect(audit.log).not.toHaveBeenCalled();
    expect(audit.logWithClient.mock.calls[0][0]).toBe(prisma);
    expect(audit.logWithClient.mock.calls[0][1]).toMatchObject({
      action: 'settings.api_keys.toggle',
      before: { apiKeysEnabled: false },
      after: { apiKeysEnabled: true },
    });
    await expect(svc.apiKeysEnabled()).resolves.toBe(true);
  });

  it('fails as a whole when the audit write fails, and never serves a stale cached gate', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow({ apiKeysEnabled: true }));
    prisma.systemSetting.findUniqueOrThrow.mockResolvedValue({ apiKeysEnabled: true });
    prisma.systemSetting.update.mockResolvedValue(baseRow({ apiKeysEnabled: false }));
    const audit = makeAudit();
    audit.logWithClient.mockRejectedValueOnce(new Error('audit down'));
    const svc = new SettingsService(prisma as never, audit as never);

    await expect(svc.apiKeysEnabled()).resolves.toBe(true); // cached "on"
    await expect(svc.setApiKeysEnabled(ACTOR, false, META)).rejects.toThrow('audit down');

    // The transaction rolled back (Prisma's contract), so the row still
    // says "on". The next read must come from the database, not a cache
    // that was skipped by the failure.
    const reads = prisma.systemSetting.findUnique.mock.calls.length;
    await svc.apiKeysEnabled();
    expect(prisma.systemSetting.findUnique.mock.calls.length).toBe(reads + 1);
  });
});
