import { DEFAULT_PASSWORD_GENERATOR_DEFAULTS } from '@weavestream/shared';
import { SettingsService } from './settings.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { FULL_PASSWORD_ACCESS } from '../passwords/password-access-policy.js';

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
  passwordAccess: FULL_PASSWORD_ACCESS,
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
    mcpRemoteEnabled: false,
    mcpClientPolicy: 'claude_chatgpt',
    passwordAccessMode: 'all_users',
    passwordAccessUserIds: [] as string[],
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
    user: { findMany: jest.fn().mockResolvedValue([]) },
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
      mcpRemoteEnabled: false,
      mcpClientPolicy: 'claude_chatgpt',
      passwordAccessMode: 'all_users',
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

describe('SettingsService MCP client policy', () => {
  it('is claude_chatgpt by default', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow({ mcpClientPolicy: 'claude_chatgpt' }));
    const svc = new SettingsService(prisma as never, makeAudit() as never);
    await expect(svc.mcpClientPolicy()).resolves.toBe('claude_chatgpt');
    await expect(svc.get()).resolves.toMatchObject({ mcpClientPolicy: 'claude_chatgpt' });
  });

  it('reads an unknown stored value as the narrow default, never as any', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow({ mcpClientPolicy: 'everyone' }));
    const svc = new SettingsService(prisma as never, makeAudit() as never);
    await expect(svc.mcpClientPolicy()).resolves.toBe('claude_chatgpt');
  });

  it('writes and audits in one transaction, then drops the cache', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow({ mcpClientPolicy: 'claude_chatgpt' }));
    prisma.systemSetting.findUniqueOrThrow.mockResolvedValue({ mcpClientPolicy: 'claude_chatgpt' });
    prisma.systemSetting.update.mockResolvedValue(baseRow({ mcpClientPolicy: 'any' }));
    const audit = makeAudit();
    const svc = new SettingsService(prisma as never, audit as never);

    await expect(svc.mcpClientPolicy()).resolves.toBe('claude_chatgpt'); // warm the cache
    const out = await svc.setMcpClientPolicy(ACTOR, 'any', META);
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow({ mcpClientPolicy: 'any' }));

    expect(out.mcpClientPolicy).toBe('any');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.systemSetting.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      select: { mcpClientPolicy: true },
    });
    expect(prisma.systemSetting.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { mcpClientPolicy: 'any', updatedBy: 'actor-1' },
    });
    expect(audit.log).not.toHaveBeenCalled();
    expect(audit.logWithClient.mock.calls[0][0]).toBe(prisma);
    expect(audit.logWithClient.mock.calls[0][1]).toMatchObject({
      action: 'settings.mcp_client_policy.change',
      entityType: 'SystemSetting',
      before: { mcpClientPolicy: 'claude_chatgpt' },
      after: { mcpClientPolicy: 'any', sessionId: 's-1' },
    });
    await expect(svc.mcpClientPolicy()).resolves.toBe('any');
  });

  it('fails as a whole when the audit write fails, and drops the cache', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow({ mcpClientPolicy: 'any' }));
    prisma.systemSetting.findUniqueOrThrow.mockResolvedValue({ mcpClientPolicy: 'any' });
    prisma.systemSetting.update.mockResolvedValue(baseRow({ mcpClientPolicy: 'claude_chatgpt' }));
    const audit = makeAudit();
    audit.logWithClient.mockRejectedValueOnce(new Error('audit down'));
    const svc = new SettingsService(prisma as never, audit as never);

    await expect(svc.mcpClientPolicy()).resolves.toBe('any');
    await expect(svc.setMcpClientPolicy(ACTOR, 'claude_chatgpt', META)).rejects.toThrow('audit down');
    const reads = prisma.systemSetting.findUnique.mock.calls.length;
    await svc.mcpClientPolicy();
    expect(prisma.systemSetting.findUnique.mock.calls.length).toBe(reads + 1);
  });
});

describe('SettingsService password access policy (issue #110)', () => {
  const OP_A = '11111111-1111-4111-8111-111111111111';
  const OP_B = '22222222-2222-4222-8222-222222222222';

  it('is all_users by default, and the user list is never in the public DTO', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(
      baseRow({ passwordAccessMode: 'selected_users', passwordAccessUserIds: [OP_A] }),
    );
    const svc = new SettingsService(prisma as never, makeAudit() as never);
    const dto = await svc.get();
    expect(dto.passwordAccessMode).toBe('selected_users');
    expect(dto).not.toHaveProperty('passwordAccessUserIds');
    expect(JSON.stringify(dto)).not.toContain(OP_A);
    await expect(svc.passwordAccessPolicy()).resolves.toEqual({
      mode: 'selected_users',
      userIds: [OP_A],
    });
  });

  it('reads an unknown stored mode as all_users', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow({ passwordAccessMode: 'bogus' }));
    const svc = new SettingsService(prisma as never, makeAudit() as never);
    await expect(svc.passwordAccessPolicy()).resolves.toEqual({ mode: 'all_users', userIds: [] });
  });

  it('rejects users that are not active operators or contractors', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow());
    prisma.user.findMany.mockResolvedValue([{ id: OP_A }]);
    const svc = new SettingsService(prisma as never, makeAudit() as never);
    await expect(
      svc.setPasswordAccessPolicy(ACTOR, { mode: 'selected_users', userIds: [OP_A, OP_B] }, META),
    ).rejects.toMatchObject({
      response: { error: 'InvalidPasswordAccessUsers', userIds: [OP_B] },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [OP_A, OP_B] },
        isActive: true,
        role: { in: ['OPERATOR', 'CONTRACTOR'] },
      },
      select: { id: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('writes de-duplicated, sorted ids and audits ids only, in one transaction', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow());
    prisma.user.findMany.mockResolvedValue([{ id: OP_A }, { id: OP_B }]);
    prisma.systemSetting.findUniqueOrThrow.mockResolvedValue({
      passwordAccessMode: 'all_users',
      passwordAccessUserIds: [],
    });
    prisma.systemSetting.update.mockResolvedValue({
      passwordAccessMode: 'selected_users',
      passwordAccessUserIds: [OP_A, OP_B],
    });
    const audit = makeAudit();
    const svc = new SettingsService(prisma as never, audit as never);

    await expect(svc.passwordAccessPolicy()).resolves.toMatchObject({ mode: 'all_users' });
    await svc.setPasswordAccessPolicy(
      ACTOR,
      { mode: 'selected_users', userIds: [OP_B, OP_A, OP_B] },
      META,
    );

    expect(prisma.systemSetting.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: {
        passwordAccessMode: 'selected_users',
        passwordAccessUserIds: [OP_A, OP_B],
        updatedBy: 'actor-1',
      },
      select: { passwordAccessMode: true, passwordAccessUserIds: true },
    });
    expect(audit.logWithClient.mock.calls[0][1]).toMatchObject({
      action: 'settings.password_access_policy.change',
      entityType: 'SystemSetting',
      before: { mode: 'all_users', userIds: [] },
      after: { mode: 'selected_users', userIds: [OP_A, OP_B], sessionId: 's-1' },
    });
    // The cache was dropped: the next read goes to the database again.
    const reads = prisma.systemSetting.findUnique.mock.calls.length;
    await svc.passwordAccessPolicy();
    expect(prisma.systemSetting.findUnique.mock.calls.length).toBe(reads + 1);
  });

  it('accepts selected_users with an empty list (only super admins pass)', async () => {
    const prisma = makePrisma();
    prisma.systemSetting.findUnique.mockResolvedValue(baseRow());
    prisma.systemSetting.findUniqueOrThrow.mockResolvedValue({
      passwordAccessMode: 'all_users',
      passwordAccessUserIds: [],
    });
    prisma.systemSetting.update.mockResolvedValue({
      passwordAccessMode: 'selected_users',
      passwordAccessUserIds: [],
    });
    const svc = new SettingsService(prisma as never, makeAudit() as never);
    await svc.setPasswordAccessPolicy(ACTOR, { mode: 'selected_users', userIds: [] }, META);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.systemSetting.update).toHaveBeenCalledTimes(1);
  });

  it('lists super admins as always included', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockResolvedValue([
      { id: 'sa', name: 'Sam', email: 's@x', role: 'SUPER_ADMIN' },
      { id: 'op', name: 'Olly', email: 'o@x', role: 'OPERATOR' },
    ]);
    const svc = new SettingsService(prisma as never, makeAudit() as never);
    await expect(svc.listPasswordAccessUsers()).resolves.toEqual([
      { id: 'sa', name: 'Sam', email: 's@x', role: 'SUPER_ADMIN', alwaysIncluded: true },
      { id: 'op', name: 'Olly', email: 'o@x', role: 'OPERATOR', alwaysIncluded: false },
    ]);
  });
});
