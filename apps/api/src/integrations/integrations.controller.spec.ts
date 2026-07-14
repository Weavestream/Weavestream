import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';
import { integrationSecretAad } from '../crypto/integration-secret-encryption.service.js';
import { Logger } from '@nestjs/common';

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
    ['listSourceOrgs', 'integration.manage'],
    ['listMappings', 'integration.manage'],
    ['createMapping', 'integration.manage'],
    ['getMapping', 'integration.manage'],
    ['updateMapping', 'integration.manage'],
    ['deleteMapping', 'integration.manage'],
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
    );

    await expect(controller.listSourceOrgs('00000000-0000-4000-8000-000000000001')).resolves.toEqual({ orgs });
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
