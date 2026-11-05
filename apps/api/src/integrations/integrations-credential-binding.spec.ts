import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CustomApiDefinitionInput, UpdateIntegrationInput } from '@weavestream/shared';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import { SECRET_BOUND_ORIGIN_MESSAGE, secretBoundOriginsChanged } from './secret-bound-config.js';

/**
 * Update-time binding of config and secret (mocked Prisma, real drivers):
 * the effective pair is validated under the row lock, a secret-bound URL
 * moves to a new origin only with a full new secret, and integrations
 * whose definition needs no secret run without one.
 */

const ID = '00000000-0000-4000-8000-0000000000c1';
const ACTOR = { id: '00000000-0000-4000-8000-0000000000c2' } as never;
const META = { ip: '127.0.0.1', userAgent: 'jest' };
const NOW = new Date('2026-11-05T00:00:00.000Z');

const crypto = {
  encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
  decrypt: (blob: string, aad: string) => {
    const prefix = `enc[${aad}]`;
    if (!blob.startsWith(prefix)) throw new Error('aad mismatch');
    return blob.slice(prefix.length);
  },
};
const aad = `integration:${ID}:secret`;

function setup(driver: string, config: Record<string, unknown>, secret: Record<string, unknown> | null) {
  const state = {
    config,
    ciphertext: secret ? crypto.encrypt(JSON.stringify(secret), aad) : null as string | null,
  };
  const order: string[] = [];
  const row = () => ({
    id: ID,
    driver,
    name: 'Inventory',
    status: 'PAUSED',
    config: state.config,
    syncCron: null,
    createdBy: 'u',
    createdAt: NOW,
    updatedAt: NOW,
    lastRunAt: null,
    lastRunStatus: null,
    secret: state.ciphertext ? { id: 'secret-1', ciphertext: state.ciphertext, updatedAt: NOW } : null,
    resources: [],
    _count: { companyMappings: 0, connections: 0 },
  });
  const tx = {
    $executeRaw: jest.fn(async (sql: TemplateStringsArray) => {
      order.push(`lock:${sql.join('?')}`);
      return 0;
    }),
    integration: {
      findUnique: jest.fn(async () => {
        order.push('read');
        return row();
      }),
      update: jest.fn(async ({ data }: { data: { config?: Record<string, unknown> } }) => {
        order.push('write');
        if (data.config) state.config = data.config;
        return row();
      }),
    },
    integrationSecret: {
      upsert: jest.fn(async ({ update }: { update: { ciphertext: string } }) => {
        state.ciphertext = update.ciphertext;
      }),
      deleteMany: jest.fn(async () => {
        state.ciphertext = null;
      }),
    },
  };
  const transactions: unknown[] = [];
  const prisma = {
    integration: { findUnique: jest.fn(async () => row()) },
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown, opts?: unknown) => {
      transactions.push(opts);
      return fn(tx);
    }),
  };
  const service = new IntegrationsService(
    prisma as never,
    crypto as never,
    { log: jest.fn(), logChange: jest.fn() } as never,
    new IntegrationDriverRegistry(),
    { values: { INTEGRATION_SYNC_DEFAULT_CRON: 'off' } } as never,
    { refreshFor: jest.fn() } as never,
    {} as never,
    {} as never,
  );
  const update = (input: Partial<UpdateIntegrationInput>) => service.update(ACTOR, ID, input as UpdateIntegrationInput, META);
  return { service, update, state, tx, order, transactions };
}

function api(overrides: Partial<CustomApiDefinitionInput> = {}): Record<string, unknown> {
  return {
    version: 1,
    baseUrl: 'https://inventory.example.com/api',
    auth: { method: 'bearer' },
    headers: [],
    organizations: { mode: 'single' },
    resources: {
      items: {
        enabled: true,
        request: { path: '/devices' },
        recordsPath: 'devices',
        idPath: 'id',
        namePath: 'name',
        matchPath: 'serial',
      },
    },
    ...overrides,
  };
}

const oauth = (tokenUrl = 'https://login.example.net/token') => ({ method: 'oauth_client_credentials', tokenUrl });

describe('IntegrationsService.update: locked effective-state validation (Custom API)', () => {
  it('locks the row before it reads, validates and writes', async () => {
    const { update, order } = setup('custom-api', api(), { token: 't' });
    await update({ config: api({ baseUrl: 'https://inventory.example.com/v2' }) });
    expect(order[0]).toMatch(/SELECT id FROM integrations WHERE id = \?::uuid FOR UPDATE/);
    expect(order.slice(1)).toEqual(['read', 'write']);
  });

  it('accepts a config-only change that keeps the method, with the saved secret', async () => {
    const { update, state } = setup('custom-api', api(), { token: 't' });
    await expect(update({ config: api({ headers: [{ name: 'Accept', value: 'application/json' }] }) })).resolves.toBeDefined();
    expect(state.ciphertext).toContain('"token":"t"');
  });

  it('refuses a method change without a new secret', async () => {
    const { update } = setup('custom-api', api(), { token: 't' });
    await expect(update({ config: api({ auth: { method: 'basic', username: 'svc' } }) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a method change with a full new secret, replacing the bundle whole', async () => {
    const { update, state } = setup('custom-api', api(), { token: 't' });
    await update({ config: api({ auth: { method: 'basic', username: 'svc' } }), secret: { password: 'pw' } });
    expect(JSON.parse(crypto.decrypt(state.ciphertext!, aad))).toEqual({ password: 'pw' });
  });

  it('validates a secret-only rotation against the saved config', async () => {
    const { update } = setup('custom-api', api(), { token: 't' });
    await expect(update({ secret: { token: 'rotated' } })).resolves.toBeDefined();
    await expect(update({ secret: { password: 'wrong-method' } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an incomplete replacement bundle', async () => {
    const config = api({ headers: [{ name: 'X-Tenant', secret: true }] });
    const { update } = setup('custom-api', config, { token: 't', 'header:x-tenant': 'a' });
    await expect(update({ secret: { token: 'rotated' } })).rejects.toThrow(/Enter all of/);
  });

  it('clearSecret: accepted with no authentication, refused with bearer', async () => {
    await expect(setup('custom-api', api({ auth: { method: 'none' } }), { token: 'stale' }).update({ clearSecret: true })).resolves.toBeDefined();
    await expect(setup('custom-api', api(), { token: 't' }).update({ clearSecret: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('secret-bound URLs', () => {
    it('refuses a new Base URL origin without a new secret, and accepts it with one', async () => {
      const moved = api({ baseUrl: 'https://other-host.example/api' });
      await expect(setup('custom-api', api(), { token: 't' }).update({ config: moved })).rejects.toThrow(SECRET_BOUND_ORIGIN_MESSAGE);
      await expect(setup('custom-api', api(), { token: 't' }).update({ config: moved, secret: { token: 'new' } })).resolves.toBeDefined();
    });

    it('accepts a new Base URL origin when no credentials are saved (no authentication)', async () => {
      const none = { method: 'none' } as never;
      const moved = api({ auth: none, baseUrl: 'https://other-host.example/api' });
      await expect(setup('custom-api', api({ auth: none }), null).update({ config: moved })).resolves.toBeDefined();
    });

    it('accepts a path-only change on the same origin', async () => {
      await expect(setup('custom-api', api(), { token: 't' }).update({ config: api({ baseUrl: 'https://inventory.example.com/v9/' }) })).resolves.toBeDefined();
    });

    it('treats a token URL that is absent before and after as unchanged', async () => {
      // A bearer definition has no auth.tokenUrl: config-only edits and name saves need no new secret.
      await expect(setup('custom-api', api(), { token: 't' }).update({ config: api({ headers: [] }) })).resolves.toBeDefined();
      await expect(setup('custom-api', api(), { token: 't' }).update({ name: 'Renamed' })).resolves.toBeDefined();
      // No authentication and no secret saved: a config-only edit passes too.
      await expect(setup('custom-api', api({ auth: { method: 'none' } }), null).update({ config: api({ auth: { method: 'none' }, headers: [] }) })).resolves.toBeDefined();
    });

    it('treats adding or removing a token URL as a host change', async () => {
      await expect(setup('custom-api', api(), { token: 't' }).update({ config: api({ auth: oauth() as never }) })).rejects.toThrow(SECRET_BOUND_ORIGIN_MESSAGE);
      await expect(setup('custom-api', api({ auth: oauth() as never }), { clientId: 'c', clientSecret: 's' }).update({ config: api() })).rejects.toThrow(SECRET_BOUND_ORIGIN_MESSAGE);
    });

    it('refuses a token URL moved to another host without a new secret', async () => {
      const saved = api({ auth: oauth() as never });
      await expect(setup('custom-api', saved, { clientId: 'c', clientSecret: 's' }).update({ config: api({ auth: oauth('https://login.evil.example/token') as never }) }))
        .rejects.toThrow(SECRET_BOUND_ORIGIN_MESSAGE);
      await expect(setup('custom-api', saved, { clientId: 'c', clientSecret: 's' }).update({ config: api({ auth: oauth('https://login.example.net/v2/token') as never }) }))
        .resolves.toBeDefined();
    });
  });
});

describe('IntegrationsService.update: Base URL binding on the 4 drivers with a stored key', () => {
  const cases = [
    ['breeze', { apiKey: 'k' }, 'https://breeze.example.com'],
    ['unifi', { apiKey: 'k' }, 'https://api.ui.com'],
    ['action1', { apiKey: 'k', apiSecret: 's' }, 'https://app.action1.com/api/3.0'],
    ['ninjaone', { apiKey: 'k', apiSecret: 's' }, 'https://app.ninjarmm.com'],
  ] as const;

  it.each(cases)('%s: a new host needs the key again; a new path does not', async (driver, secret, baseUrl) => {
    await expect(setup(driver, { baseUrl }, { ...secret }).update({ config: { baseUrl: 'https://attacker.example' } }))
      .rejects.toThrow(SECRET_BOUND_ORIGIN_MESSAGE);
    await expect(setup(driver, { baseUrl }, { ...secret }).update({ config: { baseUrl: 'https://attacker.example' }, secret: { ...secret } }))
      .resolves.toBeDefined();
    await expect(setup(driver, { baseUrl }, { ...secret }).update({ config: { baseUrl: `${baseUrl}/other` } })).resolves.toBeDefined();
  });

  it.each(cases.filter(([driver]) => driver !== 'breeze'))('%s: writing out the default Base URL is not a host change', async (driver, secret, baseUrl) => {
    await expect(setup(driver, {}, { ...secret }).update({ config: { baseUrl } })).resolves.toBeDefined();
  });

  it('a name-only save never compares hosts', async () => {
    await expect(setup('breeze', { baseUrl: 'https://breeze.example.com' }, { apiKey: 'k' }).update({ name: 'New name' })).resolves.toBeDefined();
  });
});

describe('secretBoundOriginsChanged', () => {
  const descriptor = { configFields: [], secretBoundConfigKeys: ['baseUrl', 'auth.tokenUrl'] };

  it('fails closed on a value that is not a URL', () => {
    expect(secretBoundOriginsChanged(descriptor, { baseUrl: 'https://a.example' }, { baseUrl: 'not a url' })).toBe(true);
    expect(secretBoundOriginsChanged(descriptor, { baseUrl: 'not a url' }, { baseUrl: 'not a url' })).toBe(true);
  });

  it('reads own properties only', () => {
    const inherited = Object.create({ baseUrl: 'https://evil.example' }) as Record<string, unknown>;
    expect(secretBoundOriginsChanged(descriptor, {}, inherited)).toBe(false);
  });

  it('is false for a driver with no bound keys', () => {
    expect(secretBoundOriginsChanged({ configFields: [] }, { baseUrl: 'https://a' }, { baseUrl: 'https://b' })).toBe(false);
  });
});

describe('IntegrationsService.loadDriverContext', () => {
  it('reads config and secret in one repeatable-read snapshot', async () => {
    const { service, transactions } = setup('custom-api', api(), { token: 't' });
    await service.loadDriverContext(ID);
    expect(transactions).toEqual([{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }]);
  });

  it('runs a definition with no authentication without a secret row', async () => {
    const ctx = await setup('custom-api', api({ auth: { method: 'none' } }), null).service.loadDriverContext(ID);
    expect(ctx.secret).toEqual({});
    expect(ctx.credentialVersion).toBe('no-secret|no-app');
  });

  it('still refuses to run without a secret when one is needed', async () => {
    await expect(setup('custom-api', api(), null).service.loadDriverContext(ID)).rejects.toThrow(/no credential bundle/);
    for (const driver of ['breeze', 'unifi', 'action1', 'ninjaone', 'level']) {
      await expect(setup(driver, {}, null).service.loadDriverContext(ID)).rejects.toThrow(/no credential bundle/);
    }
  });

  it('loadSavedCredentials returns a null secret instead of throwing', async () => {
    await expect(setup('custom-api', api(), null).service.loadSavedCredentials(ID)).resolves.toMatchObject({ driver: 'custom-api', secret: null });
  });
});

describe('IntegrationDto.credentialsRequired', () => {
  it('is false only for a definition that needs no secret', async () => {
    const required = (driver: string, config: Record<string, unknown>) =>
      setup(driver, config, null).service.get(ID).then((dto) => dto.credentialsRequired);
    await expect(required('custom-api', api({ auth: { method: 'none' } }))).resolves.toBe(false);
    await expect(required('custom-api', api({ auth: { method: 'none' }, headers: [{ name: 'X-Tenant', secret: true }] }))).resolves.toBe(true);
    await expect(required('custom-api', api())).resolves.toBe(true);
    // An invalid definition keeps the default: a secret is required.
    await expect(required('custom-api', { version: 1 })).resolves.toBe(true);
    await expect(required('breeze', {})).resolves.toBe(true);
    await expect(required('google-workspace', {})).resolves.toBe(true);
    await expect(required('cloudflare', {})).resolves.toBe(true);
    await expect(required('no-such-driver', {})).resolves.toBe(true);
  });
});
