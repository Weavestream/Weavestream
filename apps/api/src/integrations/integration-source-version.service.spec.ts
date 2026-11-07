import type { PrismaService } from '../prisma/prisma.service.js';
import type { EnvService } from '../config/env.service.js';
import type { IntegrationsService } from './integrations.service.js';
import type { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import type { DriverSourceVersion, IntegrationContext } from './drivers/integration-driver.js';
import {
  IntegrationSourceVersionService,
  SOURCE_VERSION_DEADLINE_MS,
} from './integration-source-version.service.js';
import { sourceVersionLabel } from './source-version.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const INTEGRATION = '22222222-2222-4222-8222-222222222222';

function setup(options: {
  read?: (ctx: IntegrationContext) => Promise<DriverSourceVersion>;
  noVersionRead?: boolean;
  run?: unknown;
  loadError?: Error;
  timeoutMs?: number;
} = {}) {
  const findUnique = jest.fn().mockResolvedValue(
    options.run === undefined
      ? { id: RUN, integrationId: INTEGRATION, integration: { driver: 'breeze' } }
      : options.run,
  );
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = { integrationSyncRun: { findUnique, updateMany } } as unknown as PrismaService;
  const env = {
    values: { INTEGRATION_HTTP_TIMEOUT_MS: options.timeoutMs ?? 30_000 },
  } as unknown as EnvService;
  const loadDriverContext = options.loadError
    ? jest.fn().mockRejectedValue(options.loadError)
    : jest.fn().mockResolvedValue({
      integrationId: INTEGRATION,
      driver: 'breeze',
      config: { baseUrl: 'https://breeze.example.test' },
      secret: { apiKey: 'k' },
      credentialVersion: 'v1',
    });
  const integrations = { loadDriverContext } as unknown as IntegrationsService;
  const readSourceVersion = jest.fn(
    options.read ?? (async () => ({ serverVersion: '0.126.0', schemaVersion: '1' })),
  );
  const driver = options.noVersionRead ? {} : { readSourceVersion };
  const drivers = {
    has: jest.fn().mockReturnValue(true),
    get: jest.fn().mockReturnValue(driver),
  } as unknown as IntegrationDriverRegistry;
  const service = new IntegrationSourceVersionService(prisma, env, integrations, drivers);
  return { service, updateMany, readSourceVersion, loadDriverContext };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('sourceVersionLabel', () => {
  it.each([
    ['0.126.0', '0.126.0'],
    ['1', '1'],
    ['v1.2.3-rc.1+build.7', 'v1.2.3-rc.1+build.7'],
    ['  0.126.0\n', '0.126.0'],
    ['unrecognized', 'unrecognized'],
  ])('keeps %j as %j', (raw, label) => {
    expect(sourceVersionLabel(raw)).toBe(label);
  });

  it.each([
    [null],
    [undefined],
    [126],
    [''],
    ['   '],
    ['0.126.0 (beta)'],
    ['<b>1</b>'],
    ['-1'],
    ['1;DROP TABLE x'],
    ['a'.repeat(65)],
  ])('rejects %j', (raw) => {
    expect(sourceVersionLabel(raw)).toBeNull();
  });
});

describe('IntegrationSourceVersionService.recordForRun', () => {
  it('saves both versions on the run, read with one short try', async () => {
    const { service, updateMany, readSourceVersion } = setup();
    await service.recordForRun(RUN);
    expect(readSourceVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        http: { timeoutMs: 5_000, maxRetries: 0, backoffMs: 0 },
        integrationId: INTEGRATION,
      }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: RUN, integrationId: INTEGRATION },
      data: { sourceServerVersion: '0.126.0', sourceSchemaVersion: '1' },
    });
  });

  it('keeps a shorter configured HTTP timeout', async () => {
    const { service, readSourceVersion } = setup({ timeoutMs: 1_500 });
    await service.recordForRun(RUN);
    expect(readSourceVersion.mock.calls[0]![0].http.timeoutMs).toBe(1_500);
  });

  it('sanitizes what the driver returns before it is stored', async () => {
    const { service, updateMany } = setup({
      read: async () => ({ serverVersion: '<img src=x onerror=alert(1)>', schemaVersion: ' 2 ' }),
    });
    await service.recordForRun(RUN);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sourceServerVersion: null, sourceSchemaVersion: '2' } }),
    );
  });

  it('writes nothing when neither version could be read', async () => {
    const { service, updateMany } = setup({
      read: async () => ({ serverVersion: null, schemaVersion: null }),
    });
    await service.recordForRun(RUN);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('never throws when the read fails', async () => {
    const { service, updateMany } = setup({
      read: async () => {
        throw new Error('Breeze partner API request failed.');
      },
    });
    await expect(service.recordForRun(RUN)).resolves.toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('never throws when the credentials cannot be loaded', async () => {
    const { service, readSourceVersion } = setup({ loadError: new Error('no credentials') });
    await expect(service.recordForRun(RUN)).resolves.toBeUndefined();
    expect(readSourceVersion).not.toHaveBeenCalled();
  });

  it('gives up on a read that never finishes', async () => {
    jest.useFakeTimers();
    const { service, updateMany } = setup({ read: () => new Promise(() => undefined) });
    const done = service.recordForRun(RUN);
    await jest.advanceTimersByTimeAsync(SOURCE_VERSION_DEADLINE_MS);
    await expect(done).resolves.toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('skips drivers without a version read, and unknown runs', async () => {
    const plain = setup({ noVersionRead: true });
    await plain.service.recordForRun(RUN);
    expect(plain.loadDriverContext).not.toHaveBeenCalled();
    expect(plain.updateMany).not.toHaveBeenCalled();

    const missing = setup({ run: null });
    await missing.service.recordForRun(RUN);
    expect(missing.readSourceVersion).not.toHaveBeenCalled();
  });
});
