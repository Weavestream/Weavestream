import { BadRequestException } from '@nestjs/common';
import type { CustomApiTestRequest } from '@weavestream/shared';
import { customApiDefinitionSchema } from '@weavestream/shared';
import { CustomApiTestController } from './custom-api-test.controller.js';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { INTERACTIVE_ONLY_KEY } from '../auth/interactive-only.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../common/egress/safe-fetch.js';
import { SECRET_BOUND_ORIGIN_MESSAGE } from './secret-bound-config.js';

const ID = '00000000-0000-4000-8000-0000000000d1';
const USER = { id: '00000000-0000-4000-8000-0000000000d2' } as never;
const REQ = { ip: '127.0.0.1', headers: { 'user-agent': 'jest' }, socket: {} } as never;
const SAVED_BASE = 'https://inventory.example.com/api';

function definition(baseUrl = SAVED_BASE) {
  return customApiDefinitionSchema.parse({
    version: 1,
    baseUrl,
    auth: { method: 'bearer' },
    organizations: { mode: 'single' },
    resources: {
      devices: { enabled: true, request: { path: '/devices' }, recordsPath: 'devices', idPath: 'id', namePath: 'name', matchPath: 'serial' },
    },
  });
}

function body(overrides: Partial<CustomApiTestRequest> = {}): CustomApiTestRequest {
  return { definition: definition(), section: 'devices', ...overrides };
}

interface Sent {
  url: string;
  authorization: string | undefined;
}

function installApi(reply: unknown = { devices: [{ id: 1, name: 'pc-1', serial: 'SN1', password: 'hunter2' }] }): Sent[] {
  const sent: Sent[] = [];
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url, authorization: headers.Authorization ?? headers.authorization });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return sent;
}

function setup(saved: { driver?: string; config?: Record<string, unknown>; secret?: Record<string, unknown> | null } = {}) {
  const integrations = {
    loadSavedCredentials: jest.fn(async () => ({
      integrationId: ID,
      driver: saved.driver ?? 'custom-api',
      config: saved.config ?? (definition() as unknown as Record<string, unknown>),
      secret: saved.secret === undefined ? { token: 'saved-token' } : saved.secret,
      credentialVersion: 'v1',
    })),
  };
  const audit = { log: jest.fn() };
  const controller = new CustomApiTestController(
    integrations as never,
    new IntegrationDriverRegistry(),
    { values: { INTEGRATION_HTTP_TIMEOUT_MS: 5_000, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1 } } as never,
    audit as never,
  );
  return { controller, audit, integrations };
}

afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

describe('CustomApiTestController security contract', () => {
  const handlers = ['testDraft', 'testSaved'] as const;
  const metadata = (key: string, handler: (typeof handlers)[number]) =>
    Reflect.getMetadata(key, CustomApiTestController.prototype[handler] as object);

  it.each(handlers)('%s needs integration.manage, an interactive session and a tight rate limit', (handler) => {
    expect(metadata(REQUIRE_PERMISSION_KEY, handler)).toEqual({ action: 'integration.manage', companyIdFrom: undefined });
    expect(metadata(INTERACTIVE_ONLY_KEY, handler)).toBe(true);
    expect(metadata(REQUIRE_STEP_UP_KEY, handler)).toBeUndefined();
    const fn = CustomApiTestController.prototype[handler] as object;
    const limitKey = Reflect.getMetadataKeys(fn).find((key) => String(key).includes('LIMIT'));
    expect(limitKey && Reflect.getMetadata(limitKey, fn)).toBe(10);
  });
});

describe('CustomApiTestController', () => {
  it('draft: uses only the body secret, masks samples, and audits by reference with no entity id', async () => {
    const sent = installApi();
    const { controller, audit, integrations } = setup();
    const response = await controller.testDraft(USER, body({ secret: { token: 'draft-token' } }), REQ);
    expect(integrations.loadSavedCredentials).not.toHaveBeenCalled();
    expect(sent[0]!.authorization).toBe('Bearer draft-token');
    expect(response).toMatchObject({ ok: true, recordCount: 1, hasMore: false });
    const text = JSON.stringify(response);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('draft-token');
    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0]![0];
    expect(entry).toMatchObject({ action: 'integration.custom_api.test', entityType: 'Integration', entityId: null });
    expect(entry.after).toEqual({ driver: 'custom-api', section: 'devices', outcome: 'ok', recordCount: 1, correlationId: response.correlationId });
    expect(JSON.stringify(entry)).not.toContain('token');
  });

  it('saved: uses the saved secret when the draft keeps the saved host', async () => {
    const sent = installApi();
    const { controller, audit } = setup();
    const response = await controller.testSaved(USER, ID, body({ definition: definition(`${SAVED_BASE}/v2`) }), REQ);
    expect(response.ok).toBe(true);
    expect(sent[0]!.authorization).toBe('Bearer saved-token');
    expect(audit.log.mock.calls[0]![0].entityId).toBe(ID);
  });

  it('saved: never sends the saved secret to a draft on another host', async () => {
    const sent = installApi();
    const { controller } = setup();
    await expect(controller.testSaved(USER, ID, body({ definition: definition('https://other-host.example/api') }), REQ))
      .rejects.toThrow(SECRET_BOUND_ORIGIN_MESSAGE);
    expect(sent).toHaveLength(0);
    // With new credentials in the body the draft host is tested with those only.
    const response = await controller.testSaved(USER, ID, body({ definition: definition('https://other-host.example/api'), secret: { token: 'new-token' } }), REQ);
    expect(response.ok).toBe(true);
    expect(sent.map((s) => s.authorization)).toEqual(['Bearer new-token']);
    expect(sent[0]!.url.startsWith('https://other-host.example/api/')).toBe(true);
  });

  it('saved: tests a draft on another host when no credentials are saved (no authentication)', async () => {
    const sent = installApi();
    const none = (baseUrl: string) => customApiDefinitionSchema.parse({ ...definition(baseUrl), auth: { method: 'none' } });
    const { controller } = setup({ config: none(SAVED_BASE) as unknown as Record<string, unknown>, secret: {} });
    const response = await controller.testSaved(USER, ID, body({ definition: none('https://other-host.example/api') }), REQ);
    expect(response.ok).toBe(true);
    expect(sent.map((s) => s.authorization)).toEqual([undefined]);
  });

  it('saved: refuses an integration of another driver', async () => {
    const { controller } = setup({ driver: 'breeze' });
    await expect(controller.testSaved(USER, ID, body(), REQ)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns fixed text and a reference on an API error, never the upstream body', async () => {
    setDefaultFetchForTests((async () => new Response('{"error":"db at 10.1.2.3 refused: password=abc"}', { status: 500 })) as typeof fetch);
    setDefaultResolveForTests(async () => ['1.2.3.4']);
    const { controller, audit } = setup();
    const response = await controller.testDraft(USER, body({ secret: { token: 't' } }), REQ);
    expect(response).toMatchObject({ ok: false, message: 'The API returned an error (500).', status: 500 });
    expect(response.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(response)).not.toContain('10.1.2.3');
    expect(audit.log.mock.calls[0]![0].after).toMatchObject({ outcome: 'failed', status: 500 });
  });
});
