import { customApiDefinitionSchema } from '@weavestream/shared';
import {
  cleanDefinition,
  createTestSection,
  customApiCreatePayload,
  customApiSavePlan,
  DuplicateQueryNames,
  emptyResource,
  exportFileName,
  InvalidJsonBody,
  issuesOf,
  newDefinition,
  planHasChanges,
  secretBoundOriginChanged,
  secretBundle,
  secretKeysFor,
  type CustomApiDraft,
} from './definition-draft';

const saved = (overrides: Partial<CustomApiDraft> = {}): CustomApiDraft => ({
  ...newDefinition('https://inventory.example.com/api', { method: 'bearer' }),
  ...overrides,
});

describe('Custom API draft helpers', () => {
  it('starts a new integration with a definition the shared schema accepts', () => {
    const draft = newDefinition('https://inventory.example.com', { method: 'bearer' });
    expect(customApiDefinitionSchema.safeParse(cleanDefinition(draft)).success).toBe(true);
    expect(draft).toMatchObject({ version: 1, organizations: { mode: 'single' }, resources: { items: { enabled: false } } });
    expect(issuesOf(draft).size).toBe(0);
  });

  it('drops blank inputs but keeps blank header values, query values and the records path', () => {
    const draft = saved({
      headers: [{ name: 'X-Empty', value: '' }],
      resources: {
        items: { ...emptyResource(), request: { method: 'GET', path: '/d', query: { q: '' } }, idPath: 'id', namePath: 'name', matchPath: 'serial' },
      },
    });
    const clean = cleanDefinition(draft) as { headers: unknown[]; resources: { items: Record<string, unknown> } };
    expect(clean.headers).toEqual([{ name: 'X-Empty', value: '' }]);
    expect(clean.resources.items.request).toEqual({ method: 'GET', path: '/d', query: { q: '' } });
    expect(clean.resources.items.recordsPath).toBe('');
    expect(clean.resources.items).not.toHaveProperty('orgIdPath');
    expect(clean.resources.items).not.toHaveProperty('recordUrl');
    expect(issuesOf(draft).size).toBe(0);
  });

  it('refuses a POST body that is not valid JSON at the body path', () => {
    const draft = saved({
      resources: {
        items: {
          ...emptyResource(),
          request: { method: 'POST', path: '/d', query: {}, body: new InvalidJsonBody('{ nope') },
          idPath: 'id',
          namePath: 'name',
          matchPath: 'serial',
        },
      },
    });
    expect(issuesOf(draft).get('resources.items.request.body')).toBe('The body must be plain JSON.');
  });

  it('keys issues by their schema path', () => {
    const issues = issuesOf(saved({ baseUrl: 'http://inventory.example.com' }));
    expect(issues.get('baseUrl')).toMatch(/https/);
  });

  it('lists exactly the secret keys, including secret headers, and bundles only those', () => {
    const draft = saved({ headers: [{ name: 'X-Tenant', secret: true }, { name: 'Accept', value: 'application/json' }] });
    expect(secretKeysFor(draft)).toEqual(['token', 'header:x-tenant']);
    expect(secretKeysFor(saved({ auth: { method: 'none' } }))).toEqual([]);
    expect(secretBundle(['token', 'header:x-tenant'], { token: 't', 'header:x-tenant': 'h', password: 'old' })).toEqual({
      token: 't',
      'header:x-tenant': 'h',
    });
  });

  it('flags a host change of the Base URL or token URL, not a path change', () => {
    const oauth = (tokenUrl: string) => ({ method: 'oauth_client_credentials' as const, tokenUrl });
    expect(secretBoundOriginChanged(saved() as never, saved({ baseUrl: 'https://inventory.example.com/v2' }))).toBe(false);
    expect(secretBoundOriginChanged(saved() as never, saved({ baseUrl: 'https://other.example.com/api' }))).toBe(true);
    expect(
      secretBoundOriginChanged(saved({ auth: oauth('https://login.example.net/t') }) as never, saved({ auth: oauth('https://login.example.net/v2/t') })),
    ).toBe(false);
    expect(
      secretBoundOriginChanged(saved({ auth: oauth('https://login.example.net/t') }) as never, saved({ auth: oauth('https://evil.example/t') })),
    ).toBe(true);
  });

  it('builds the create payload from the whole definition and exactly the needed secret keys', () => {
    const draft = saved({ headers: [{ name: 'X-Tenant', secret: true }] });
    expect(customApiCreatePayload(draft, { token: 't', 'header:x-tenant': 'h', value: 'stale' })).toEqual({
      config: cleanDefinition(draft),
      secret: { token: 't', 'header:x-tenant': 'h' },
    });
    expect(customApiCreatePayload(saved({ auth: { method: 'none' } }), { token: 'stale' })).not.toHaveProperty('secret');
  });

  it('picks the create-dialog Test section from the organization mode', () => {
    expect(createTestSection(saved())).toBeNull();
    expect(createTestSection(saved({ organizations: { mode: 'field' } }))).toBe('organizations');
    expect(
      createTestSection(saved({ resources: { items: emptyResource() } })),
    ).toBe('items');
  });

  it('makes a safe download name', () => {
    expect(exportFileName('Inventory (prod)')).toBe('Inventory _prod_.custom-api.json');
    expect(exportFileName('../../etc/passwd')).not.toMatch(/\//);
    expect(exportFileName('')).toBe('definition.custom-api.json');
  });
});

describe('customApiSavePlan', () => {
  const plan = (draft: CustomApiDraft, options: { hasSecret?: boolean; values?: Record<string, unknown>; rotate?: boolean; saved?: CustomApiDraft } = {}) =>
    customApiSavePlan({
      saved: cleanDefinition(options.saved ?? saved()),
      hasSecret: options.hasSecret ?? true,
      draft,
      values: options.values ?? {},
      rotate: options.rotate ?? false,
    });

  it('sends nothing secret for an unchanged definition', () => {
    const result = plan(saved());
    expect(result).toMatchObject({ configChanged: false, entering: false, secretPatch: {}, blocked: null });
  });

  it('keeps the saved secret for a change on the same host with the same method', () => {
    const result = plan(saved({ baseUrl: 'https://inventory.example.com/v2' }));
    expect(result).toMatchObject({ configChanged: true, secretReason: null, secretPatch: {}, blocked: null });
  });

  it('requires the credentials again after a host change', () => {
    const draft = saved({ baseUrl: 'https://other.example.com/api' });
    expect(plan(draft)).toMatchObject({ entering: true, blocked: 'The host changed. Enter the credentials again for the new host.' });
    expect(plan(draft, { values: { token: 'new' } })).toMatchObject({ blocked: null, secretPatch: { secret: { token: 'new' } } });
  });

  it('requires a full new bundle after a method change, including secret headers', () => {
    const draft = saved({ auth: { method: 'basic', username: 'svc' }, headers: [{ name: 'X-Tenant', secret: true }] });
    expect(plan(draft, { values: { password: 'p' } }).blocked).toMatch(/authentication changed/);
    expect(plan(draft, { values: { password: 'p', 'header:x-tenant': 'h', token: 'old' } }).secretPatch).toEqual({
      secret: { password: 'p', 'header:x-tenant': 'h' },
    });
  });

  it('clears the saved secret when the definition no longer needs one', () => {
    expect(plan(saved({ auth: { method: 'none' } })).secretPatch).toEqual({ clearSecret: true });
    expect(plan(saved({ auth: { method: 'none' } }), { hasSecret: false }).secretPatch).toEqual({});
  });

  it('sends a rotation only when every key is filled', () => {
    expect(plan(saved(), { rotate: true, values: { token: 'r' } }).secretPatch).toEqual({ secret: { token: 'r' } });
    const partial = plan(saved({ headers: [{ name: 'X-Tenant', secret: true }] }), {
      saved: saved({ headers: [{ name: 'X-Tenant', secret: true }] }),
      rotate: true,
      values: { token: 'r' },
    });
    expect(partial.secretPatch).toEqual({});
    expect(partial.blocked).toMatch(/Enter every credential/);
  });

  it('refuses to save an invalid definition', () => {
    expect(plan(saved({ baseUrl: 'not a url' })).blocked).toMatch(/Fix the problem/);
  });

  it('sees no change when the saved config has its keys in another order (PostgreSQL JSONB)', () => {
    const draft = saved({ resources: { items: { ...emptyResource(), idPath: 'id', namePath: 'name', matchPath: 'serial' } } });
    const reversed = (value: unknown): unknown =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
        : value;
    const stored = reversed(cleanDefinition(draft)) as CustomApiDraft;
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(cleanDefinition(draft)));
    expect(plan(draft, { saved: stored })).toMatchObject({ configChanged: false, secretPatch: {}, blocked: null });
    expect(planHasChanges(plan(draft, { saved: stored }))).toBe(false);
    expect(planHasChanges(plan(saved({ baseUrl: 'https://inventory.example.com/v2' }), { saved: stored }))).toBe(true);
  });
});

describe('DuplicateQueryNames', () => {
  it('is refused at the query path, so Save, Test and Export stay blocked', () => {
    const draft = saved({
      resources: {
        items: {
          ...emptyResource(),
          request: { method: 'GET', path: '/devices', query: new DuplicateQueryNames([['page', '1'], ['page', '2']]) as never },
          idPath: 'id',
          namePath: 'name',
          matchPath: 'serial',
        },
      },
    });
    expect([...issuesOf(draft).keys()]).toEqual(['resources.items.request.query']);
  });
});
