import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { MICROSOFT_REPORT_SETTING } from '@weavestream/shared';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../../common/egress/safe-fetch.js';
import { integrationConnectionSecretAad } from '../../crypto/integration-secret-encryption.service.js';
import { __resetOAuthAccessTokenCacheForTests } from '../oauth/oauth-token.js';
import { MicrosoftReportNamesService, REPORT_NAMES_NOT_CHANGEABLE, REPORT_NAMES_NOT_READABLE } from './microsoft-report-names.service.js';

const ID = '00000000-0000-4000-8000-000000000091';
const TENANT = '11111111-2222-4333-8444-555555555555';
const CONN = '00000000-0000-4000-8000-0000000000c1';
const AAD = integrationConnectionSecretAad(ID, CONN);
const SETTINGS_URL = 'https://graph.microsoft.com/v1.0/admin/reportSettings';
const META = { ip: '127.0.0.1', userAgent: 'jest' };
const ACTOR = { id: 'user-1' } as never;

const crypto = {
  encrypt: (plaintext: string, aad: string) => `enc[${aad}]${plaintext}`,
  decrypt: (blob: string, aad: string) => blob.slice(`enc[${aad}]`.length),
};

/** Tenant state behind the scripted Graph: GET reads it, PATCH writes it. */
function graph(initial: boolean | 'forbidden', patchStatus = 204) {
  let concealed = initial;
  const calls: Array<{ method: string; body?: string }> = [];
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('https://login.microsoftonline.com/')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (url !== SETTINGS_URL) throw new Error(`unscripted ${url}`);
    calls.push({ method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (concealed === 'forbidden') return new Response(JSON.stringify({ error: { code: 'Forbidden', message: 'internal' } }), { status: 403 });
    if (method === 'PATCH') {
      if (patchStatus !== 204) return new Response(JSON.stringify({ error: { code: 'Forbidden' } }), { status: patchStatus });
      concealed = (JSON.parse(String(init?.body)) as { displayConcealedNames: boolean }).displayConcealedNames;
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ displayConcealedNames: concealed }), { status: 200 });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return { calls, state: () => concealed };
}

function setup(choice?: 'shown' | 'hidden', grantedRoles: string[] = ['ReportSettings.ReadWrite.All']) {
  let secret: Record<string, unknown> = { tenantId: TENANT, grantedRoles, consentedAt: '2026-10-01T00:00:00.000Z', ...(choice ? { reportNames: choice } : {}) };
  const integrations = {
    loadDriverContext: jest.fn(async () => ({
      integrationId: ID,
      driver: 'microsoft-365',
      config: {},
      secret,
      oauthClient: { clientId: 'client-1', clientSecret: 'client-secret-1' },
      credentialVersion: `v-${Math.random()}`,
    })),
  };
  const prisma = {
    integrationConnection: {
      findFirst: jest.fn(async (): Promise<{ secretCiphertext: string } | null> => ({ secretCiphertext: crypto.encrypt(JSON.stringify(secret), AAD) })),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; integrationId: string; secretCiphertext: string }; data: { secretCiphertext: string } }) => {
        if (where.id !== CONN || where.integrationId !== ID) return { count: 0 };
        if (where.secretCiphertext !== crypto.encrypt(JSON.stringify(secret), AAD)) return { count: 0 };
        secret = JSON.parse(crypto.decrypt(data.secretCiphertext, AAD));
        return { count: 1 };
      }),
    },
  };
  const audit = { log: jest.fn(async () => undefined) };
  const env = { values: { INTEGRATION_HTTP_TIMEOUT_MS: 5_000, INTEGRATION_HTTP_MAX_RETRIES: 0, INTEGRATION_HTTP_BACKOFF_MS: 1 } };
  const service = new MicrosoftReportNamesService(prisma as never, integrations as never, crypto as never, audit as never, env as never);
  return { service, audit, prisma, integrations, secret: () => secret, setSecret: (v: Record<string, unknown>) => { secret = v; } };
}

beforeEach(() => {
  __resetOAuthAccessTokenCacheForTests();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

describe('MicrosoftReportNamesService', () => {
  it('names the exact admin-center setting and its Graph property', () => {
    expect(MICROSOFT_REPORT_SETTING.label).toBe('Conceal user, group, and site names in all reports');
    expect(MICROSOFT_REPORT_SETTING.path).toBe('Microsoft 365 admin center > Settings > Org settings > Services > Reports');
    expect(MICROSOFT_REPORT_SETTING.graph).toContain('displayConcealedNames');
  });

  it('reads the current tenant value before asking (GET only)', async () => {
    const { calls } = graph(true);
    const ctx = setup();
    await expect(ctx.service.status(ID, CONN)).resolves.toEqual({ concealed: true, choice: null, readError: null, canChange: true });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    // Per connection: only that tenant's grant is loaded.
    expect(ctx.integrations.loadDriverContext).toHaveBeenCalledWith(ID, { connectionId: CONN });
  });

  it('reports an unreadable setting with fixed text naming it', async () => {
    graph('forbidden');
    const status = await setup().service.status(ID, CONN);
    expect(status.concealed).toBeNull();
    expect(status.readError).toContain(`"${MICROSOFT_REPORT_SETTING.label}"`);
    expect(status.readError).not.toContain('internal');
  });

  it('show: reads, then PATCHes displayConcealedNames false once, stores the choice and audits before/after', async () => {
    const { calls, state } = graph(true);
    const { service, audit, secret } = setup();
    const result = await service.apply(ACTOR, ID, CONN, { action: 'show' }, META);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ displayConcealedNames: false });
    expect(state()).toBe(false);
    expect(secret().reportNames).toBe('shown');
    expect(result).toMatchObject({ concealed: false, choice: 'shown' });
    expect(result.message).toBe(`Done: "${MICROSOFT_REPORT_SETTING.label}" is now Off (real names shown) for this tenant. Microsoft applies it within a few minutes; the next sync uses it.`);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.microsoft.report_names',
      entityId: ID,
      before: { choice: null, displayConcealedNames: true },
      after: expect.objectContaining({
        tenantId: TENANT,
        setting: MICROSOFT_REPORT_SETTING.label,
        path: MICROSOFT_REPORT_SETTING.path,
        graphProperty: 'displayConcealedNames',
        action: 'show',
        displayConcealedNames: false,
        changed: true,
      }),
    }));
  });

  it('keep: changes nothing in the tenant and records the choice', async () => {
    const { calls, state } = graph(true);
    const { service, audit, secret } = setup();
    const result = await service.apply(ACTOR, ID, CONN, { action: 'keep' }, META);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(state()).toBe(true);
    expect(secret().reportNames).toBe('hidden');
    expect(result.message).toContain('Nothing was changed in the tenant');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ after: expect.objectContaining({ action: 'keep', changed: false }) }));
  });

  it('keep records that names are shown when the tenant already shows them, still changing nothing', async () => {
    const { calls } = graph(false);
    const { service, secret } = setup();
    const result = await service.apply(ACTOR, ID, CONN, { action: 'keep' }, META);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(secret().reportNames).toBe('shown');
    expect(result).toMatchObject({ choice: 'shown', concealed: false });
  });

  it('conceal: turns concealment back on with one audited PATCH', async () => {
    const { calls, state } = graph(false);
    const { service, audit, secret } = setup('shown');
    const result = await service.apply(ACTOR, ID, CONN, { action: 'conceal' }, META);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ displayConcealedNames: true });
    expect(state()).toBe(true);
    expect(secret().reportNames).toBe('hidden');
    expect(result.message).toContain('is now On (names hidden)');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      before: { choice: 'shown', displayConcealedNames: false },
      after: expect.objectContaining({ action: 'conceal', displayConcealedNames: true, changed: true }),
    }));
  });

  it('does not PATCH when the tenant already has the wanted value', async () => {
    const { calls } = graph(false);
    const result = await setup().service.apply(ACTOR, ID, CONN, { action: 'show' }, META);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(result.message).toContain('was already Off (real names shown); nothing was changed');
  });

  it('audits a refused change and answers with fixed text', async () => {
    graph(true, 403);
    const { service, audit, secret } = setup();
    await expect(service.apply(ACTOR, ID, CONN, { action: 'show' }, META)).rejects.toThrow(/ReportSettings\.ReadWrite\.All is not granted/);
    expect(secret().reportNames).toBeUndefined();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'integration.microsoft.report_names.failed', after: expect.objectContaining({ reason: 'forbidden' }) }));
  });

  it('never changes a setting it could not read first', async () => {
    const { calls } = graph('forbidden');
    await expect(setup().service.apply(ACTOR, ID, CONN, { action: 'show' }, META)).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('without the optional write permission: shows the value, cannot change, never PATCHes, audits the refusal', async () => {
    const { calls, state } = graph(true);
    const { service, audit, secret } = setup(undefined, ['ReportSettings.Read.All']);
    await expect(service.status(ID, CONN)).resolves.toEqual({ concealed: true, choice: null, readError: null, canChange: false });
    await expect(service.apply(ACTOR, ID, CONN, { action: 'show' }, META)).rejects.toThrow(REPORT_NAMES_NOT_CHANGEABLE);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(state()).toBe(true);
    expect(secret().reportNames).toBeUndefined();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.microsoft.report_names.failed',
      after: expect.objectContaining({ reason: 'not_granted', action: 'show' }),
    }));
    // keep still works: it changes nothing.
    await expect(service.apply(ACTOR, ID, CONN, { action: 'keep' }, META)).resolves.toMatchObject({ choice: 'hidden', canChange: false });
  });

  it('without any report-settings permission: does not call Graph and says the read permission is missing', async () => {
    const { calls } = graph(true);
    const status = await setup(undefined, ['User.Read.All']).service.status(ID, CONN);
    expect(status).toEqual({ concealed: null, choice: null, readError: REPORT_NAMES_NOT_READABLE, canChange: false });
    expect(calls).toEqual([]);
  });

  it('keeps stored fields this schema does not know when saving the choice', async () => {
    graph(true);
    const { service, secret, setSecret } = setup();
    setSecret({ ...secret(), futureField: { kept: true } });
    await service.apply(ACTOR, ID, CONN, { action: 'keep' }, META);
    expect(secret()).toMatchObject({ reportNames: 'hidden', futureField: { kept: true } });
  });

  it('refuses to store the choice over a reconnect that happened meanwhile', async () => {
    graph(true);
    const { service, prisma, setSecret } = setup();
    prisma.integrationConnection.findFirst.mockImplementationOnce(async () => {
      const other = { tenantId: TENANT, grantedRoles: [], consentedAt: '2026-10-02T00:00:00.000Z' };
      setSecret(other);
      return { secretCiphertext: crypto.encrypt(JSON.stringify(other), AAD) };
    });
    await expect(service.apply(ACTOR, ID, CONN, { action: 'keep' }, META)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.integrationConnection.updateMany).not.toHaveBeenCalled();
  });

  it('refuses when a reconnect lands between the re-read and the write (compare-and-set)', async () => {
    graph(true);
    const { service, prisma, secret, setSecret } = setup();
    const original = secret();
    prisma.integrationConnection.findFirst.mockImplementationOnce(async () => {
      const read = { secretCiphertext: crypto.encrypt(JSON.stringify(original), AAD) };
      setSecret({ ...original, consentedAt: '2026-10-03T00:00:00.000Z' });
      return read;
    });
    await expect(service.apply(ACTOR, ID, CONN, { action: 'keep' }, META)).rejects.toBeInstanceOf(ConflictException);
    expect(secret().consentedAt).toBe('2026-10-03T00:00:00.000Z');
  });

  it('audits a tenant change even when the choice cannot be stored afterwards', async () => {
    const { state } = graph(true);
    const { service, audit, prisma } = setup();
    prisma.integrationConnection.findFirst.mockImplementationOnce(async () => null);
    await expect(service.apply(ACTOR, ID, CONN, { action: 'show' }, META)).rejects.toBeInstanceOf(ConflictException);
    expect(state()).toBe(false);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'integration.microsoft.report_names',
      after: expect.objectContaining({ action: 'show', changed: true, choiceStored: false }),
    }));
  });
});
