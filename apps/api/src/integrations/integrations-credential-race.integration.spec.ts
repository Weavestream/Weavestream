import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { CustomApiTestRequest, UpdateIntegrationInput } from '@weavestream/shared';
import { customApiDefinitionSchema } from '@weavestream/shared';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../common/egress/safe-fetch.js';
import { integrationSecretAad } from '../crypto/integration-secret-encryption.service.js';
import { IntegrationsService } from './integrations.service.js';
import { CustomApiTestController } from './custom-api-test.controller.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import { SECRET_BOUND_ORIGIN_MESSAGE } from './secret-bound-config.js';
import {
  createDisposableReconstructionDatabase,
  reconstructionDatabaseTemplate,
  type DisposableReconstructionDatabase,
} from './reconstruction/reconstruction-test-database.js';

/**
 * Real-PostgreSQL proof that a host and a credential are never paired
 * across two saves: concurrent updates run one after the other under the
 * row lock, and a reader gets the row and its secret from one snapshot
 * even when a save commits between Prisma's two queries.
 *
 * Needs WEAVESTREAM_RECONSTRUCTION_TEST_DATABASE_URL (a local, dedicated
 * weavestream_task11_* database); skipped without it.
 */

const HOST_A = 'https://host-a.example.com/api';
const HOST_B = 'https://host-b.example.com/api';
const ACTOR = { id: randomUUID() } as never;
const META = { ip: '127.0.0.1', userAgent: 'jest' };

const crypto = {
  encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
  decrypt: (blob: string, aad: string) => {
    const prefix = `enc[${aad}]`;
    if (!blob.startsWith(prefix)) throw new Error('aad mismatch');
    return blob.slice(prefix.length);
  },
};

function definition(baseUrl: string) {
  return customApiDefinitionSchema.parse({
    version: 1,
    baseUrl,
    auth: { method: 'bearer' },
    organizations: { mode: 'single' },
    resources: {
      items: { enabled: true, request: { path: '/devices' }, recordsPath: 'devices', idPath: 'id', namePath: 'name', matchPath: 'serial' },
    },
  }) as unknown as Record<string, unknown>;
}

/** Resolves when `open()` is called; lets a test hold a transaction at a chosen step. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

type Hooks = {
  /** Runs inside the next update transaction, before its integration row write. */
  beforeRowWrite?: () => Promise<void>;
  /** Runs between the two reads of a credential snapshot. */
  betweenReads?: () => Promise<void>;
};

/**
 * The real client, with hooks inside its transactions. A credential read
 * (`integration.findUnique` with `include.secret`) runs as the two queries
 * Prisma sends, with `betweenReads` in between, so a test can commit a
 * concurrent save at the exact point the race needs.
 */
function hookedClient(prisma: PrismaClient, hooks: Hooks, opts: { dropIsolation?: boolean } = {}) {
  const wrapTx = (tx: Prisma.TransactionClient) => new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'integration') {
        const model = target.integration;
        return new Proxy(model, {
          get(m, key) {
            if (key === 'findUnique') {
              return async (args: { where: { id: string }; include?: { secret?: boolean } }) => {
                if (!args.include?.secret) return m.findUnique(args as never);
                const row = await m.findUnique({ where: args.where });
                if (!row) return null;
                const hook = hooks.betweenReads;
                hooks.betweenReads = undefined;
                await hook?.();
                const secret = await target.integrationSecret.findUnique({ where: { integrationId: row.id } });
                return { ...row, secret };
              };
            }
            if (key === 'update') {
              return async (args: never) => {
                const hook = hooks.beforeRowWrite;
                hooks.beforeRowWrite = undefined;
                await hook?.();
                return m.update(args);
              };
            }
            return Reflect.get(m, key);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (fn: (tx: Prisma.TransactionClient) => unknown, txOpts?: { isolationLevel?: unknown }) =>
          target.$transaction(
            (tx) => fn(wrapTx(tx)) as Promise<unknown>,
            opts.dropIsolation ? undefined : (txOpts as never),
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function service(prisma: PrismaClient) {
  return new IntegrationsService(
    prisma as never,
    crypto as never,
    { log: jest.fn(), logChange: jest.fn() } as never,
    new IntegrationDriverRegistry(),
    { values: { INTEGRATION_SYNC_DEFAULT_CRON: 'off' } } as never,
    { refreshFor: jest.fn() } as never,
    {} as never,
    {} as never,
  );
}

const databaseUrl = process.env['WEAVESTREAM_RECONSTRUCTION_TEST_DATABASE_URL'];
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('Integration credential binding on PostgreSQL', () => {
  let database: DisposableReconstructionDatabase;
  let prisma: PrismaClient;
  let id: string;

  async function saved(): Promise<{ baseUrl: unknown; token: unknown }> {
    const row = await prisma.integration.findUniqueOrThrow({ where: { id }, include: { secret: true } });
    const secret = JSON.parse(crypto.decrypt(row.secret!.ciphertext, integrationSecretAad(id))) as { token: unknown };
    return { baseUrl: (row.config as { baseUrl: unknown }).baseUrl, token: secret.token };
  }

  /** A concurrent save on its own connection: host B with credential B. */
  async function commitHostB() {
    await prisma.$transaction([
      prisma.integration.update({ where: { id }, data: { config: definition(HOST_B) as Prisma.InputJsonValue } }),
      prisma.integrationSecret.update({
        where: { integrationId: id },
        data: { ciphertext: crypto.encrypt(JSON.stringify({ token: 'B' }), integrationSecretAad(id)) },
      }),
    ]);
  }

  beforeAll(async () => {
    database = await createDisposableReconstructionDatabase(
      reconstructionDatabaseTemplate(databaseUrl),
      `${process.pid}-${randomUUID()}`,
    );
    prisma = database.prisma;
    await prisma.$connect();
  }, 120_000);

  beforeEach(async () => {
    await database.reset();
    id = randomUUID();
    await prisma.integration.create({
      data: {
        id,
        driver: 'custom-api',
        name: 'Inventory',
        config: definition(HOST_A) as Prisma.InputJsonValue,
        secret: { create: { ciphertext: crypto.encrypt(JSON.stringify({ token: 'A' }), integrationSecretAad(id)) } },
      },
    });
  }, 30_000);

  afterEach(() => {
    setDefaultFetchForTests(null);
    setDefaultResolveForTests(null);
  });

  afterAll(async () => {
    if (database) await database.drop();
  }, 30_000);

  describe('concurrent updates', () => {
    async function race(first: Partial<UpdateIntegrationInput>, second: Partial<UpdateIntegrationInput>) {
      const hooks: Hooks = {};
      const svc = service(hookedClient(prisma, hooks));
      const holding = gate();
      const release = gate();
      hooks.beforeRowWrite = async () => {
        holding.open();
        await release.opened;
      };
      const firstSave = svc.update(ACTOR, id, first as UpdateIntegrationInput, META);
      await holding.opened;
      let secondDone = false;
      const secondSave = svc.update(ACTOR, id, second as UpdateIntegrationInput, META)
        .finally(() => { secondDone = true; });
      secondSave.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The second save waits on the row lock the first one holds.
      expect(secondDone).toBe(false);
      release.open();
      return Promise.allSettled([firstSave, secondSave]);
    }

    it('host change + config-only edit: the config-only edit is checked against the new host and refused', async () => {
      const [first, second] = await race(
        { config: definition(HOST_B), secret: { token: 'B' } },
        { config: definition(`${HOST_A}/v2`) },
      );
      expect(first.status).toBe('fulfilled');
      expect(second).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: SECRET_BOUND_ORIGIN_MESSAGE }) });
      expect(await saved()).toEqual({ baseUrl: HOST_B, token: 'B' });
    });

    it('config-only edit + host change: the host change waits and writes host B with credential B', async () => {
      const [first, second] = await race(
        { config: definition(`${HOST_A}/v2`) },
        { config: definition(HOST_B), secret: { token: 'B' } },
      );
      expect(first.status).toBe('fulfilled');
      expect(second.status).toBe('fulfilled');
      expect(await saved()).toEqual({ baseUrl: HOST_B, token: 'B' });
    });

    it('host change + secret-only rotation: the rotation waits and lands on host B', async () => {
      const [first, second] = await race(
        { config: definition(HOST_B), secret: { token: 'B' } },
        { secret: { token: 'C' } },
      );
      expect(first.status).toBe('fulfilled');
      expect(second.status).toBe('fulfilled');
      expect(await saved()).toEqual({ baseUrl: HOST_B, token: 'C' });
    });
  });

  describe('credential snapshot reads', () => {
    it('control: without the snapshot, a save between the two queries pairs host A with credential B', async () => {
      const hooks: Hooks = { betweenReads: commitHostB };
      const svc = service(hookedClient(prisma, hooks, { dropIsolation: true }));
      const ctx = await svc.loadDriverContext(id);
      expect({ baseUrl: ctx.config.baseUrl, token: ctx.secret.token }).toEqual({ baseUrl: HOST_A, token: 'B' });
    });

    it('loadDriverContext returns host A with credential A when a save commits between the queries', async () => {
      const hooks: Hooks = { betweenReads: commitHostB };
      const svc = service(hookedClient(prisma, hooks));
      const ctx = await svc.loadDriverContext(id);
      expect({ baseUrl: ctx.config.baseUrl, token: ctx.secret.token }).toEqual({ baseUrl: HOST_A, token: 'A' });
      expect(await saved()).toEqual({ baseUrl: HOST_B, token: 'B' });
    });

    it('the saved-integration Test route never sends credential B to host A', async () => {
      const sent: Array<{ url: string; authorization: string | undefined }> = [];
      setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        sent.push({ url, authorization: headers.Authorization ?? headers.authorization });
        return new Response(JSON.stringify({ devices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch);
      setDefaultResolveForTests(async () => ['1.2.3.4']);
      const hooks: Hooks = { betweenReads: commitHostB };
      const controller = new CustomApiTestController(
        service(hookedClient(prisma, hooks)),
        new IntegrationDriverRegistry(),
        { values: { INTEGRATION_HTTP_TIMEOUT_MS: 5_000, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1 } } as never,
        { log: jest.fn() } as never,
      );
      const body = { definition: definition(HOST_A), section: 'items' } as unknown as CustomApiTestRequest;
      const response = await controller.testSaved(ACTOR, id, body, { ip: '127.0.0.1', headers: {}, socket: {} } as never);
      expect(response.ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url.startsWith(`${HOST_A}/`)).toBe(true);
      expect(sent[0]!.authorization).toBe('Bearer A');
    });
  });
});
