import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';
import { integrationSecretAad } from '../crypto/integration-secret-encryption.service.js';
import { Logger } from '@nestjs/common';
import { DriverAuthError, DriverRateLimitError } from './drivers/integration-driver.js';

describe('IntegrationsController security contract', () => {
  const metadata = (key: string, handler: keyof IntegrationsController) =>
    Reflect.getMetadata(key, IntegrationsController.prototype[handler] as object);

  it.each(['create', 'update', 'delete'] as const)(
    '%s requires integration.manage and step-up',
    (handler) => {
      expect(metadata(REQUIRE_PERMISSION_KEY, handler)).toEqual({
        action: 'integration.manage',
        companyIdFrom: undefined,
      });
      expect(metadata(REQUIRE_STEP_UP_KEY, handler)).toEqual({});
    },
  );

  it.each([
    ['list', 'integration.manage'],
    ['get', 'integration.manage'],
    ['testConnection', 'integration.manage'],
    ['checkSetup', 'integration.manage'],
    ['listSourceOrgs', 'integration.manage'],
    ['listMappings', 'integration.manage'],
    ['createMapping', 'integration.manage'],
    ['getMapping', 'integration.manage'],
    ['updateMapping', 'integration.manage'],
    ['deleteMapping', 'integration.manage'],
    ['getCompleteness', 'integration.manage'],
    ['listGaps', 'integration.manage'],
    ['createResourceDestination', 'integration.manage'],
    ['triggerSync', 'sync.trigger'],
  ] as const)('%s retains the %s permission contract', (handler, action) => {
    expect(metadata(REQUIRE_PERMISSION_KEY, handler)).toEqual({
      action,
      companyIdFrom: undefined,
    });
  });

  it('returns all driver-listed organizations without filtering unmapped rows', async () => {
    const orgs = [
      { externalId: 'org-mapped', name: 'Mapped' },
      { externalId: 'org-unmapped', name: 'Unmapped' },
    ];
    const controller = new IntegrationsController(
      { loadDriverContext: jest.fn().mockResolvedValue({ driver: 'breeze', config: {}, secret: {} }) } as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue({ listSourceOrgs: jest.fn().mockResolvedValue(orgs) }) } as never,
      { values: { INTEGRATION_HTTP_TIMEOUT_MS: 1, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1 } } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(controller.listSourceOrgs('00000000-0000-4000-8000-000000000001')).resolves.toEqual({ orgs });
  });

  function checkSetupController(env: { API_URL: string; APP_URL: string }) {
    const diagnose = jest.fn().mockResolvedValue({
      ok: false, passedStepIds: ['project'], failures: [{ stepId: 'apis', message: 'Enable it.' }],
    });
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const loadDriverContext = jest.fn().mockResolvedValue({ integrationId: 'i-1', driver: 'level', config: {}, secret: { apiKey: 'test-key' } });
    const testConnection = jest.fn().mockResolvedValue({ ok: true });
    const controller = new IntegrationsController(
      { loadDriverContext } as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue({ diagnose, testConnection }), kindOf: () => 'sync' } as never,
      { values: { ...env, INTEGRATION_HTTP_TIMEOUT_MS: 1, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1 } } as never,
      audit as never,
      {} as never,
      {} as never,
    );
    const run = () =>
      controller.checkSetup({ id: 'actor' } as never, '00000000-0000-4000-8000-000000000001', { ip: '127.0.0.1', headers: {} } as never);
    const test = () =>
      controller.testConnection({ id: 'actor' } as never, '00000000-0000-4000-8000-000000000001', { ip: '127.0.0.1', headers: {} } as never);
    return { diagnose, audit, run, test, loadDriverContext, testConnection };
  }

  it('runs the driver connection check and audits only the outcome and step ids', async () => {
    const { diagnose, audit, run } = checkSetupController({ API_URL: 'https://ws.example.test/api', APP_URL: 'https://ws.example.test' });
    const result = await run();
    expect(result.failures).toEqual([{ stepId: 'apis', message: 'Enable it.' }]);
    expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ mode: 'connection', ctx: expect.objectContaining({ integrationId: 'i-1' }) }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.setup_check', after: { ok: false, failedStepIds: ['apis'] },
    }));
  });

  it.each([
    ['auth', new DriverAuthError('refused'), 'The provider refused the connection. Reconnect the integration and try again.'],
    ['rate limit', new DriverRateLimitError('slow down'), 'The provider is rate limiting requests. Try again in a minute.'],
  ])('turns a driver %s error from diagnose into an audited failed check', async (_kind, error, message) => {
    const { diagnose, audit, run } = checkSetupController({ API_URL: 'https://ws.example.test/api', APP_URL: 'https://ws.example.test' });
    diagnose.mockRejectedValueOnce(error);
    const result = await run();
    expect(result).toEqual({ ok: false, passedStepIds: [], failures: [{ stepId: null, message }] });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.setup_check', after: { ok: false, failedStepIds: [null] },
    }));
  });

  it('lets an unexpected diagnose error surface as a server error', async () => {
    const { diagnose, audit, run } = checkSetupController({ API_URL: 'https://ws.example.test/api', APP_URL: 'https://ws.example.test' });
    diagnose.mockRejectedValueOnce(new Error('boom'));
    await expect(run()).rejects.toThrow('boom');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([true, false])('propagates dryRun=%s through the existing sync route', async (dryRun) => {
    const triggerManual = jest.fn().mockResolvedValue({ id: 'run' });
    const controller = new IntegrationsController(
      {} as never,
      {} as never,
      { triggerManual } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const user = { id: 'actor' } as never;
    const req = { ip: '127.0.0.1', headers: {} } as never;

    await controller.triggerSync(
      user,
      '00000000-0000-4000-8000-000000000001',
      { dryRun, mode: 'incremental' },
      req,
    );

    expect(triggerManual).toHaveBeenCalledWith(
      user,
      expect.any(String),
      dryRun,
      expect.any(Object),
      'incremental',
    );
  });

  it('delegates validated completeness and gap filters to integration-scoped reads', async () => {
    const integrations = {
      getReconstructionCompleteness: jest.fn().mockResolvedValue({ counts: {}, rows: [] }),
      listReconstructionGaps: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const controller = new IntegrationsController(
      integrations as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never,
      {} as never,
    );
    const query = {
      mappingId: '00000000-0000-4000-8000-000000000002',
      resourceId: '00000000-0000-4000-8000-000000000003',
    };
    await controller.getCompleteness('00000000-0000-4000-8000-000000000001', query);
    await controller.listGaps('00000000-0000-4000-8000-000000000001', {
      ...query, resolution: 'active', limit: 50,
    });
    expect(integrations.getReconstructionCompleteness).toHaveBeenCalledWith(expect.any(String), query);
    expect(integrations.listReconstructionGaps).toHaveBeenCalledWith(expect.any(String), {
      ...query, resolution: 'active', limit: 50,
    });
  });
});

describe('IntegrationsService secret boundary', () => {
  const actorId = '00000000-0000-4000-8000-000000000010';
  const actor = { id: actorId } as never;
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  function setup() {
    const id = '00000000-0000-4000-8000-000000000011';
    const now = new Date('2026-07-14T00:00:00.000Z');
    let ciphertext: string | null = null;
    const row = () => ({
      id,
      driver: 'breeze',
      name: 'Breeze',
      status: 'PAUSED',
      config: { baseUrl: 'https://breeze.example' },
      syncCron: null,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastRunStatus: null,
      secret: ciphertext ? { ciphertext } : null,
      resources: [],
      _count: { companyMappings: 0 },
    });
    const tx = {
      integration: {
        create: jest.fn().mockResolvedValue(row()),
        update: jest.fn().mockResolvedValue(row()),
      },
      integrationResource: { create: jest.fn() },
      integrationSecret: {
        create: jest.fn(async ({ data }: { data: { ciphertext: string } }) => {
          ciphertext = data.ciphertext;
        }),
        upsert: jest.fn(async ({ update }: { update: { ciphertext: string } }) => {
          ciphertext = update.ciphertext;
        }),
        deleteMany: jest.fn(),
      },
    };
    const prisma = {
      integration: {
        findUnique: jest.fn(async () => row()),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const plaintexts = new Map<string, string>();
    const crypto = {
      encrypt: jest.fn((plaintext: string, _aad: string) => {
        const blob = `cipher-${plaintexts.size + 1}`;
        plaintexts.set(blob, plaintext);
        return blob;
      }),
      decrypt: jest.fn((blob: string) => plaintexts.get(blob)!),
    };
    const audit = { log: jest.fn(), logChange: jest.fn() };
    const descriptor = {
      key: 'breeze', label: 'Breeze', description: null, iconKey: null,
      configFields: [], secretFields: [], resources: [],
      capabilities: { kind: 'pull', listSourceOrgs: true, dryRun: true, ticketing: false },
    };
    const drivers = {
      describe: jest.fn().mockReturnValue(descriptor),
      get: jest.fn().mockReturnValue({}),
      kindOf: jest.fn().mockReturnValue('pull'),
      has: jest.fn().mockReturnValue(true),
    };
    const service = new IntegrationsService(
      prisma as never,
      crypto as never,
      audit as never,
      drivers as never,
      { values: { INTEGRATION_SYNC_DEFAULT_CRON: '*/15 * * * *' } } as never,
      { refreshFor: jest.fn() } as never,
      {} as never,
    );
    return { service, id, crypto, audit, tx };
  }

  it('encrypts create secrets with integration AAD and returns only a mask', async () => {
    const { service, id, crypto, audit, tx } = setup();
    const apiKey = 'top-secret-api-key';
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const dto = await service.create(actor, {
      driver: 'breeze', name: 'Breeze', config: {}, secret: { apiKey }, status: 'PAUSED',
    }, meta);

    expect(crypto.encrypt).toHaveBeenCalledWith(JSON.stringify({ apiKey }), integrationSecretAad(id));
    expect(tx.integrationSecret.create).toHaveBeenCalledWith({
      data: { integrationId: id, ciphertext: 'cipher-1' },
    });
    expect(dto).toMatchObject({ hasSecret: true, secretMask: { apiKey: '••••-key' } });
    expect(JSON.stringify(dto)).not.toContain(apiKey);
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(apiKey);
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(apiKey);
    loggerError.mockRestore();
  });

  it('encrypts rotated secrets with the same AAD and keeps audits confidential', async () => {
    const { service, id, crypto, audit } = setup();
    const apiKey = 'replacement-secret';
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const dto = await service.update(actor, id, { secret: { apiKey } }, meta);

    expect(crypto.encrypt).toHaveBeenCalledWith(JSON.stringify({ apiKey }), integrationSecretAad(id));
    expect(dto.secretMask).toEqual({ apiKey: '••••cret' });
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(apiKey);
    expect(JSON.stringify(audit.logChange.mock.calls)).not.toContain(apiKey);
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(apiKey);
    loggerError.mockRestore();
  });
});

describe('IntegrationsService resource seeding', () => {
  it('seeds rows enabled unless the descriptor opts the resource out', async () => {
    const actor = { id: '00000000-0000-4000-8000-000000000010' } as never;
    const meta = { ip: '127.0.0.1', userAgent: 'jest' };
    const id = '00000000-0000-4000-8000-000000000012';
    const now = new Date('2026-07-14T00:00:00.000Z');
    const row = {
      id,
      driver: 'breeze',
      name: 'Breeze',
      status: 'PAUSED',
      config: {},
      syncCron: null,
      createdBy: '00000000-0000-4000-8000-000000000010',
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastRunStatus: null,
      secret: null,
      resources: [],
      _count: { companyMappings: 0 },
    };
    const tx = {
      integration: { create: jest.fn().mockResolvedValue(row) },
      integrationResource: { create: jest.fn() },
      integrationSecret: { create: jest.fn() },
    };
    const prisma = {
      integration: { findUnique: jest.fn(async () => row) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const descriptor = {
      key: 'breeze', label: 'Breeze', description: null, iconKey: null,
      configFields: [], secretFields: [],
      resources: [
        {
          key: 'devices', label: 'Devices', targetKind: 'asset',
          targetConfig: {}, dependsOnResourceKeys: [],
        },
        {
          key: 'device-relationships', label: 'Device relationships', targetKind: 'relation',
          targetConfig: {}, dependsOnResourceKeys: ['devices'], defaultEnabled: false,
        },
      ],
      capabilities: { kind: 'pull', listSourceOrgs: true, dryRun: true, ticketing: false },
    };
    const drivers = {
      describe: jest.fn().mockReturnValue(descriptor),
      get: jest.fn().mockReturnValue({}),
      kindOf: jest.fn().mockReturnValue('pull'),
      has: jest.fn().mockReturnValue(true),
    };
    const service = new IntegrationsService(
      prisma as never,
      { encrypt: jest.fn(), decrypt: jest.fn() } as never,
      { log: jest.fn(), logChange: jest.fn() } as never,
      drivers as never,
      { values: { INTEGRATION_SYNC_DEFAULT_CRON: '*/15 * * * *' } } as never,
      { refreshFor: jest.fn() } as never,
      {} as never,
    );

    await service.create(actor, { driver: 'breeze', name: 'Breeze', config: {}, status: 'PAUSED' }, meta);

    expect(
      tx.integrationResource.create.mock.calls.map(
        ([{ data }]: [{ data: { resourceKey: string; enabled: boolean } }]) => [
          data.resourceKey,
          data.enabled,
        ],
      ),
    ).toEqual([
      ['devices', true],
      ['device-relationships', false],
    ]);
  });
});

describe('IntegrationsController Cloudflare domains company binding', () => {
  const ACTOR = { id: 'u-1', role: 'OPERATOR' } as never;
  const COMPANY = { id: '00000000-0000-4000-8000-0000000000c1', archivedAt: null };

  function make(allowed: boolean) {
    const create = jest.fn(async (_u: unknown, dto: { config: unknown }) => dto);
    const can = jest.fn().mockResolvedValue({ allowed });
    const controller = new IntegrationsController(
      { create } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { company: { findUnique: jest.fn().mockResolvedValue(COMPANY) } } as never,
      { can } as never,
    );
    return { controller, create, can };
  }
  const req = { headers: {}, ip: '198.51.100.7' } as never;

  it('stores the resolved company id once the saver may manage domains there', async () => {
    const { controller, create, can } = make(true);
    await controller.create(
      ACTOR,
      { driver: 'cloudflare', name: 'cf', config: { accountId: 'a', domainsCompanySlug: ' client ' } } as never,
      req,
    );
    expect(can).toHaveBeenCalledWith(ACTOR, 'domain.manage', { companyId: COMPANY.id });
    expect(create.mock.calls[0]![1].config).toEqual({
      accountId: 'a',
      domainsCompanySlug: 'client',
      domainsCompanyId: COMPANY.id,
    });
  });

  it('refuses a company the saver cannot manage domains in', async () => {
    const { controller, create } = make(false);
    await expect(
      controller.create(
        ACTOR,
        { driver: 'cloudflare', name: 'cf', config: { accountId: 'a', domainsCompanySlug: 'other' } } as never,
        req,
      ),
    ).rejects.toThrow(/cannot manage domains/);
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the bound id without re-checking when the slug is unchanged', async () => {
    // Re-resolving would 403 an editor without access to that company and,
    // after a slug rename, could silently point the sync at another company.
    const update = jest.fn(async (_u: unknown, _id: string, dto: { config: unknown }) => dto);
    const can = jest.fn();
    const findUnique = jest.fn();
    const controller = new IntegrationsController(
      {
        update,
        get: jest.fn().mockResolvedValue({
          driver: 'cloudflare',
          config: { accountId: 'a', domainsCompanySlug: 'client', domainsCompanyId: COMPANY.id },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { company: { findUnique } } as never,
      { can } as never,
    );
    await controller.update(
      ACTOR,
      '00000000-0000-4000-8000-000000000001',
      { config: { accountId: 'a', domainsCompanySlug: 'client', note: 'x' } } as never,
      req,
    );
    expect(can).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(update.mock.calls[0]![2].config).toEqual({
      note: 'x',
      accountId: 'a',
      domainsCompanySlug: 'client',
      domainsCompanyId: COMPANY.id,
    });
  });

  it('re-checks when the Cloudflare account changes, even with the same slug', async () => {
    // Otherwise someone with integration.manage could point an authorised
    // binding at their own account and write into a company they can't manage.
    const can = jest.fn().mockResolvedValue({ allowed: false });
    const controller = new IntegrationsController(
      {
        update: jest.fn(),
        get: jest.fn().mockResolvedValue({
          driver: 'cloudflare',
          config: { accountId: 'a', domainsCompanySlug: 'client', domainsCompanyId: COMPANY.id },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { company: { findUnique: jest.fn().mockResolvedValue(COMPANY) } } as never,
      { can } as never,
    );
    await expect(
      controller.update(
        ACTOR,
        '00000000-0000-4000-8000-000000000001',
        { config: { accountId: 'attacker', domainsCompanySlug: 'client' } } as never,
        req,
      ),
    ).rejects.toThrow(/cannot manage domains/);
    expect(can).toHaveBeenCalled();
  });

  it('discards a client-supplied company id', async () => {
    const { controller, create } = make(true);
    await controller.create(
      ACTOR,
      {
        driver: 'cloudflare',
        name: 'cf',
        config: { accountId: 'a', domainsCompanyId: '00000000-0000-4000-8000-0000000000ff' },
      } as never,
      req,
    );
    expect(create.mock.calls[0]![1].config).toEqual({ accountId: 'a' });
  });
});

describe('IntegrationsController Create new layout permission', () => {
  const ACTOR = { id: 'u-1', role: 'OPERATOR' } as never;
  const req = { headers: {}, ip: '198.51.100.7' } as never;

  function make(allowed: boolean) {
    const createResourceDestination = jest.fn().mockResolvedValue({ key: 'devices' });
    const can = jest.fn().mockResolvedValue({ allowed });
    const controller = new IntegrationsController(
      { createResourceDestination } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { can } as never,
    );
    return { controller, createResourceDestination, can };
  }

  it('refuses with 403 when the operator cannot manage layouts', async () => {
    const { controller, createResourceDestination, can } = make(false);
    await expect(controller.createResourceDestination(ACTOR, 'i-1', 'devices', req)).rejects.toThrow(
      /manage asset layouts/,
    );
    expect(can).toHaveBeenCalledWith(ACTOR, 'layout.manage.global');
    expect(createResourceDestination).not.toHaveBeenCalled();
  });

  it('creates the layout when the operator may manage layouts', async () => {
    const { controller, createResourceDestination } = make(true);
    await expect(controller.createResourceDestination(ACTOR, 'i-1', 'devices', req)).resolves.toEqual({ key: 'devices' });
    expect(createResourceDestination).toHaveBeenCalled();
  });
});
