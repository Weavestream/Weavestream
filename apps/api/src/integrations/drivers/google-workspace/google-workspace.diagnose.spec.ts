import { driverDescriptorSchema, integrationSetupCheckSchema } from '@weavestream/shared';
import type { IntegrationContext } from '../integration-driver.js';
import { GoogleWorkspaceDriver } from './google-workspace.driver.js';
import { GOOGLE_WORKSPACE_SETUP_GUIDE } from './google-workspace.setup-guide.js';
import { __resetOAuthAccessTokenCacheForTests } from '../../oauth/oauth-token.js';
import { setDefaultFetchForTests, setDefaultResolveForTests } from '../../../common/egress/safe-fetch.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DIR = 'https://admin.googleapis.com/admin/directory/v1';
const LICENSING = 'https://licensing.googleapis.com/apps/licensing/v1';
const REPORTS = 'https://admin.googleapis.com/admin/reports/v1';
const RAW = 'raw Google text that must never reach the client';

type Reply = { status?: number; body: unknown };

function install(table: Record<string, Reply>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
    const key = keys.find((k) => url.startsWith(k));
    if (!key) throw new Error(`unscripted fetch to ${url}`);
    const reply = table[key]!;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return calls;
}

const http = { timeoutMs: 5_000, maxRetries: 0, backoffMs: 1 };
const driver = new GoogleWorkspaceDriver();
const clientCheck = () => driver.diagnose({
  mode: 'client',
  oauthClient: { clientId: 'client-1', clientSecret: 'client-secret-1' },
  redirectUri: 'https://weavestream.example.com/v1/admin/integrations/oauth/callback',
  http,
  correlationId: 'corr-1',
});

let seq = 0;
function connectionCheck() {
  seq += 1;
  const ctx: IntegrationContext = {
    config: {},
    secret: { refreshToken: 'refresh-1', grantedScopes: [], connectedAt: '2026-10-01T00:00:00.000Z' },
    oauthClient: { clientId: 'client-1', clientSecret: 'client-secret-1' },
    integrationId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    correlationId: 'corr-1',
    http,
  };
  return driver.diagnose({ mode: 'connection', ctx });
}

const tokenError = (error: string, status = 400): Record<string, Reply> => ({
  [TOKEN_URL]: { status, body: { error, error_description: RAW } },
});
const googleError = (status: number, reason: string, v2 = false): Reply => ({
  status,
  body: v2
    ? { error: { code: status, message: RAW, status: 'PERMISSION_DENIED', details: [{ reason }] } }
    : { error: { code: status, message: RAW, errors: [{ reason, message: RAW }] } },
});
const OK_TABLE: Record<string, Reply> = {
  [TOKEN_URL]: { body: { access_token: 'access-1', expires_in: 3600 } },
  [`${DIR}/customers/my_customer`]: { body: { id: 'C0example1', customerDomain: 'example.com' } },
  [`${LICENSING}/product/Google-Apps/users`]: { body: { items: [] } },
  [`${REPORTS}/usage/dates/`]: { body: { usageReports: [] } },
};

function noRawText(result: unknown) {
  expect(JSON.stringify(result)).not.toContain('raw Google text');
}

beforeEach(() => __resetOAuthAccessTokenCacheForTests());
afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
});

describe('Google Workspace setup guide', () => {
  it('passes the shared descriptor schema with https-only links and unique ids', () => {
    expect(() => driverDescriptorSchema.parse(driver.descriptor)).not.toThrow();
    const links = GOOGLE_WORKSPACE_SETUP_GUIDE.flatMap((s) => s.links ?? []);
    expect(links.every((l) => l.href.startsWith('https://'))).toBe(true);
    expect(GOOGLE_WORKSPACE_SETUP_GUIDE.map((s) => s.id)).toEqual([
      'project', 'apis', 'consent', 'scopes', 'client', 'credentials', 'connect', 'trust', 'layouts',
    ]);
  });

  it('never contains an em-dash', () => {
    expect(JSON.stringify(GOOGLE_WORKSPACE_SETUP_GUIDE)).not.toContain('\u2014');
  });
});

describe('diagnose: client check (dummy authorization code)', () => {
  it('treats invalid_grant as a working client', async () => {
    const calls = install(tokenError('invalid_grant'));
    const result = await clientCheck();
    // Only the client id and secret are proven; the redirect URI waits for a real connect.
    expect(integrationSetupCheckSchema.parse(result)).toEqual({
      ok: true, passedStepIds: ['project', 'credentials'], failures: [],
      notes: [{ stepId: 'client', message: 'Redirect URI is confirmed on the first successful connect.' }],
    });
    const sent = new URLSearchParams(calls[0]!.body);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_id')).toBe('client-1');
    expect(sent.get('redirect_uri')).toContain('/oauth/callback');
  });

  it.each(['invalid_client', 'unauthorized_client'])('maps %s to the credentials step', async (code) => {
    install(tokenError(code, 401));
    const result = await clientCheck();
    expect(result).toMatchObject({ ok: false, passedStepIds: [], failures: [{ stepId: 'credentials' }] });
    noRawText(result);
  });

  it('maps redirect_uri_mismatch to the client step', async () => {
    install(tokenError('redirect_uri_mismatch'));
    const result = await clientCheck();
    expect(result).toMatchObject({ ok: false, failures: [{ stepId: 'client' }] });
    expect(result.passedStepIds).toContain('credentials');
    noRawText(result);
  });

  it('maps an unknown token error to a fixed message without provider text', async () => {
    install(tokenError('something_new', 500));
    const result = await clientCheck();
    expect(result).toMatchObject({ ok: false, failures: [{ stepId: 'credentials' }] });
    noRawText(result);
  });
});

describe('diagnose: connection check', () => {
  it('passes every step up to trust when all four APIs answer, using GET only', async () => {
    const calls = install(OK_TABLE);
    const result = await connectionCheck();
    expect(result.ok).toBe(true);
    expect(new Set(result.passedStepIds)).toEqual(new Set(['project', 'consent', 'client', 'credentials', 'apis', 'connect', 'scopes', 'trust']));
    const api = calls.filter((c) => c.url !== TOKEN_URL);
    expect(api.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
    expect(api[1]!.url).toContain('customerId=C0example1');
    expect(api[1]!.url).toContain('maxResults=1');
  });

  it.each([
    ['accessNotConfigured (v1 shape)', `${LICENSING}/product/Google-Apps/users`, googleError(403, 'accessNotConfigured'), 'Enterprise License Manager API'],
    ['SERVICE_DISABLED (v2 shape)', `${REPORTS}/usage/dates/`, googleError(403, 'SERVICE_DISABLED', true), 'Admin SDK API (Reports)'],
  ])('maps %s to step 2 naming the API', async (_label, url, reply, api) => {
    install({ ...OK_TABLE, [url]: reply });
    const result = await connectionCheck();
    expect(result).toMatchObject({ ok: false, failures: [{ stepId: 'apis' }] });
    expect(result.failures[0]!.message).toContain(api);
    expect(result.passedStepIds).not.toContain('apis');
    expect(result.passedStepIds).toContain('trust');
    expect(result.passedStepIds).not.toContain('scopes');
    noRawText(result);
  });

  it('maps a 403 without admin rights to step 7 (admin role)', async () => {
    install({ ...OK_TABLE, [`${REPORTS}/usage/dates/`]: googleError(403, 'insufficientPermissions') });
    const result = await connectionCheck();
    expect(result).toMatchObject({ ok: false, failures: [{ stepId: 'connect' }] });
    expect(result.failures[0]!.message).toMatch(/admin/);
    noRawText(result);
  });

  it('maps a missing scope to step 7 with a reconnect hint', async () => {
    install({ ...OK_TABLE, [`${REPORTS}/usage/dates/`]: googleError(403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', true) });
    const result = await connectionCheck();
    expect(result.failures).toEqual([expect.objectContaining({ stepId: 'connect', message: expect.stringMatching(/tick every permission/) })]);
  });

  it('maps admin_policy_enforced to step 8 (Trusted)', async () => {
    install({ ...OK_TABLE, [`${DIR}/customers/my_customer`]: googleError(403, 'admin_policy_enforced') });
    const result = await connectionCheck();
    expect(result.failures[0]).toMatchObject({ stepId: 'trust' });
    noRawText(result);
  });

  it('maps admin_policy_enforced on the token refresh to step 8', async () => {
    install(tokenError('admin_policy_enforced'));
    const result = await connectionCheck();
    expect(result).toEqual({ ok: false, passedStepIds: [], failures: [expect.objectContaining({ stepId: 'trust' })] });
  });

  it('maps org_internal to step 3 (Audience External)', async () => {
    install(tokenError('org_internal'));
    const result = await connectionCheck();
    expect(result.failures[0]).toMatchObject({ stepId: 'consent' });
  });

  it('maps a revoked or expired grant (invalid_grant) to Reconnect', async () => {
    install(tokenError('invalid_grant'));
    const result = await connectionCheck();
    expect(result.failures).toEqual([expect.objectContaining({ stepId: 'connect', message: expect.stringMatching(/Reconnect/) })]);
    noRawText(result);
  });

  it('maps invalid_client on refresh to the credentials step', async () => {
    install(tokenError('invalid_client', 401));
    const result = await connectionCheck();
    expect(result.failures[0]).toMatchObject({ stepId: 'credentials' });
  });

  it('reports rate limiting without a step', async () => {
    install({ ...OK_TABLE, [`${REPORTS}/usage/dates/`]: googleError(429, 'rateLimitExceeded') });
    const result = await connectionCheck();
    expect(result.failures).toEqual([expect.objectContaining({ stepId: null })]);
    expect(result.passedStepIds).not.toContain('scopes');
    expect(result.passedStepIds).not.toContain('trust');
  });

  it('skips the licensing probe when the tenant id is unknown', async () => {
    const calls = install({ ...OK_TABLE, [`${DIR}/customers/my_customer`]: googleError(403, 'forbidden') });
    await connectionCheck();
    expect(calls.some((c) => c.url.startsWith(LICENSING))).toBe(false);
  });

  it('does not pass trust when no API answered', async () => {
    const disabled = googleError(403, 'accessNotConfigured');
    install({
      [TOKEN_URL]: OK_TABLE[TOKEN_URL]!,
      [`${DIR}/customers/my_customer`]: disabled,
      [`${REPORTS}/usage/dates/`]: disabled,
    });
    const result = await connectionCheck();
    expect(result.passedStepIds).not.toContain('trust');
    expect(result.passedStepIds).not.toContain('apis');
  });
});
