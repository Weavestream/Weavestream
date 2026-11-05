import {
  CUSTOM_API_LIMITS,
  customApiDefinitionSchema,
  customApiRequiredSecretKeys,
  customApiTestRequestSchema,
  isReservedHeaderName,
  placeholdersIn,
  type CustomApiDefinitionInput,
} from './custom-api.js';
import { INTEGRATION_SECTION_LIMITS } from './integration-section.js';

/** The example from the spec: a cursor API with groups. */
function definition(overrides: Partial<CustomApiDefinitionInput> = {}): CustomApiDefinitionInput {
  return {
    version: 1,
    baseUrl: 'https://inventory.example.com',
    auth: { method: 'bearer' },
    headers: [
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Tenant', secret: true },
    ],
    organizations: {
      mode: 'endpoint',
      request: { method: 'GET', path: '/api/v1/groups' },
      recordsPath: 'groups',
      idPath: 'id',
      namePath: 'name',
      pagination: { style: 'none' },
    },
    resources: {
      items: {
        enabled: true,
        request: { method: 'GET', path: '/api/v1/devices', query: { group: '{orgId}', cursor: '{cursor}' } },
        recordsPath: 'devices',
        pagination: { style: 'cursor', cursorPath: 'nextCursor' },
        idPath: 'id',
        namePath: 'name',
        matchPath: 'system.serial',
        fields: [
          { key: 'hostname', label: 'Hostname', path: 'hostname', type: 'TEXT' },
          { key: 'agent_version', label: 'Agent version', path: 'agentVersion', type: 'TEXT' },
          { key: 'last_contact', label: 'Last contact', path: 'lastContactAt', type: 'DATETIME' },
        ],
        recordUrl: 'https://app.example.com/devices/{id}',
      },
    },
    ...overrides,
  };
}

function issues(input: unknown): string[] {
  const result = customApiDefinitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

function withItems(patch: Record<string, unknown>): CustomApiDefinitionInput {
  const base = definition();
  return { ...base, resources: { items: { ...(base.resources.items as object), ...patch } as never } };
}

describe('customApiDefinitionSchema', () => {
  it('accepts the spec example and fills defaults', () => {
    const parsed = customApiDefinitionSchema.parse(definition());
    expect(customApiDefinitionSchema.parse({ ...definition(), resources: {} }).resources.items).toEqual({ enabled: false });
    expect(parsed.organizations.mode === 'endpoint' && parsed.organizations.pagination).toEqual({ style: 'none' });
  });

  it('needs version 1', () => {
    expect(issues({ ...definition(), version: 2 }).join()).toMatch(/version/);
    expect(issues({ ...definition(), version: undefined }).join()).toMatch(/version/);
  });

  it('refuses unknown keys', () => {
    expect(issues({ ...definition(), extra: true }).length).toBeGreaterThan(0);
  });

  it.each([
    ['http://inventory.example.com', /https:\/\//],
    ['https://user:pw@inventory.example.com', /user name or password/],
    ['https://inventory.example.com/api?x=1', /query string/],
    ['https://inventory.example.com/#x', /fragment/],
    ['not a url', /not a valid URL/],
  ])('refuses the Base URL %s', (baseUrl, message) => {
    expect(issues(definition({ baseUrl })).join()).toMatch(message);
  });

  it('allows a path prefix on the Base URL', () => {
    expect(issues(definition({ baseUrl: 'https://example.com/inventory/' }))).toEqual([]);
  });

  describe('auth', () => {
    it('accepts each method', () => {
      for (const auth of [
        { method: 'none' },
        { method: 'bearer' },
        { method: 'header', headerName: 'X-Api-Key' },
        { method: 'basic', username: 'svc' },
        { method: 'oauth_client_credentials', tokenUrl: 'https://login.example.net/oauth/token', scope: 'read' },
      ]) {
        expect(issues(definition({ auth: auth as never }))).toEqual([]);
      }
    });

    it('needs an HTTPS token URL and refuses a reserved auth header name', () => {
      expect(issues(definition({ auth: { method: 'oauth_client_credentials', tokenUrl: 'http://login.example.net/t' } as never })).join()).toMatch(/https/);
      expect(issues(definition({ auth: { method: 'header', headerName: 'Authorization' } })).join()).toMatch(/cannot be set/);
      expect(issues(definition({ auth: { method: 'basic', username: 'a:b' } })).join()).toMatch(/":"/);
    });
  });

  describe('headers', () => {
    it.each(['Host', 'content-length', 'Transfer-Encoding', 'Connection', 'Upgrade', 'TE', 'Trailer', 'Keep-Alive', 'Proxy-Authorization', 'Cookie', 'Authorization'])(
      'refuses the reserved header %s',
      (name) => {
        expect(isReservedHeaderName(name)).toBe(true);
        expect(issues(definition({ headers: [{ name, value: 'x' }] })).join()).toMatch(/cannot be set/);
      },
    );

    it('refuses the auth method header, duplicates, bad names and control characters', () => {
      expect(issues(definition({ auth: { method: 'header', headerName: 'X-Api-Key' }, headers: [{ name: 'x-api-key', value: 'v' }] })).join()).toMatch(/cannot be set/);
      expect(issues(definition({ headers: [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }] })).join()).toMatch(/twice/);
      expect(issues(definition({ headers: [{ name: 'Bad Name', value: '1' }] })).join()).toMatch(/header name/);
      expect(issues(definition({ headers: [{ name: 'X-A', value: 'a\r\nInjected: 1' }] })).join()).toMatch(/control/);
    });

    it('allows at most 16 headers', () => {
      const headers = Array.from({ length: CUSTOM_API_LIMITS.headers + 1 }, (_, i) => ({ name: `X-H${i}`, value: 'v' }));
      expect(issues(definition({ headers })).length).toBeGreaterThan(0);
      expect(issues(definition({ headers: headers.slice(0, CUSTOM_API_LIMITS.headers) }))).toEqual([]);
    });
  });

  describe('placeholders', () => {
    it('finds placeholders in a template', () => {
      expect(placeholdersIn('/a/{orgId}/b?{cursor}')).toEqual(['orgId', 'cursor']);
    });

    it('refuses unknown placeholders and {updatedSince}', () => {
      expect(issues(withItems({ request: { path: '/d/{nope}', query: { cursor: '{cursor}' } } })).join()).toMatch(/\{nope\} is not a placeholder/);
      expect(issues(withItems({ request: { path: '/d', query: { cursor: '{cursor}', since: '{updatedSince}' } } })).join()).toMatch(/updatedSince/);
    });

    it('allows {orgId} in endpoint mode only', () => {
      expect(issues(withItems({ request: { path: '/groups/{orgId}/devices', query: { cursor: '{cursor}' } } }))).toEqual([]);
      const single = { ...withItems({}), organizations: { mode: 'single' } } as CustomApiDefinitionInput;
      expect(issues(single).join()).toMatch(/\{orgId\} cannot be used here/);
      const orgRequest = definition({
        organizations: { mode: 'endpoint', request: { path: '/groups/{orgId}' }, idPath: 'id', namePath: 'name' },
      });
      expect(issues(orgRequest).join()).toMatch(/\{orgId\} cannot be used here/);
    });

    it('needs the pagination placeholder in the request', () => {
      expect(issues(withItems({ request: { path: '/d', query: { group: '{orgId}' } } })).join()).toMatch(/cursor pagination needs \{cursor\}/);
      expect(issues(withItems({ request: { path: '/d', query: { group: '{orgId}', p: '{page}' } }, pagination: { style: 'page', pageSize: 100 } }))).toEqual([]);
      expect(issues(withItems({ request: { path: '/d', query: { group: '{orgId}', p: '{page}' } }, pagination: { style: 'offset', pageSize: 100 } })).join()).toMatch(/\{page\} cannot be used/);
    });

    it('allows placeholders in POST body string values only', () => {
      const ok = withItems({ request: { method: 'POST', path: '/d', body: { group: '{orgId}', after: '{cursor}', n: 5 } } });
      expect(issues(ok)).toEqual([]);
      const inKey = withItems({ request: { method: 'POST', path: '/d', body: { '{orgId}': 1, after: '{cursor}' } } });
      expect(issues(inKey).join()).toMatch(/not in keys/);
      const getBody = withItems({ request: { method: 'GET', path: '/d', query: { c: '{cursor}' }, body: { a: 1 } } });
      expect(issues(getBody).join()).toMatch(/Only a POST/);
    });

    it('refuses a query string or a backslash in the request path', () => {
      expect(issues(withItems({ request: { path: '/d?x={cursor}' } })).join()).toMatch(/Query/);
      expect(issues(withItems({ request: { path: '/d\\x', query: { c: '{cursor}' } } })).join()).toMatch(/\\/);
      expect(issues(withItems({ request: { path: 'd', query: { c: '{cursor}' } } })).join()).toMatch(/starts with \//);
    });
  });

  describe('resources', () => {
    it('makes the match path optional', () => {
      expect(issues(withItems({ matchPath: undefined }))).toEqual([]);
    });

    it('refuses an old resource key and standard fields', () => {
      const old = definition({
        resources: { devices: { enabled: true, request: { path: '/x' }, idPath: 'id', namePath: 'name' } } as never,
      });
      expect(issues(old).join()).toMatch(/Unrecognized key/);
      expect(issues(withItems({ standardFields: { hostname: 'h' } })).length).toBeGreaterThan(0);
    });

    it('needs orgIdPath on each enabled resource in field mode', () => {
      const field = { ...definition(), organizations: { mode: 'field' } } as CustomApiDefinitionInput;
      const items = { ...(field.resources.items as object), request: { path: '/d', query: { c: '{cursor}' } } };
      expect(issues({ ...field, resources: { items } }).join()).toMatch(/organization id path/);
      expect(issues({ ...field, resources: { items: { ...items, orgIdPath: 'groupId' } } })).toEqual([]);
    });

    it('checks fields: key form, reserved keys, duplicates, type and the limit', () => {
      const field = (key: string, type = 'TEXT') => ({ key, label: 'L', path: 'p', type });
      expect(issues(withItems({ fields: [field('AgentVersion')] })).join()).toMatch(/lower-case/);
      expect(issues(withItems({ fields: [field('name')] })).join()).toMatch(/used by Weavestream/);
      expect(issues(withItems({ fields: [field('match_key')] })).join()).toMatch(/used by Weavestream/);
      expect(issues(withItems({ fields: [field('a'), field('a')] })).join()).toMatch(/twice/);
      expect(issues(withItems({ fields: [field('a', 'FILE')] })).length).toBeGreaterThan(0);
      const many = Array.from({ length: CUSTOM_API_LIMITS.fieldsPerResource + 1 }, (_, i) => field(`f${i}`));
      expect(issues(withItems({ fields: many })).length).toBeGreaterThan(0);
      expect(issues(withItems({ fields: many.slice(0, CUSTOM_API_LIMITS.fieldsPerResource) }))).toEqual([]);
    });

    it('checks paths with the path grammar', () => {
      expect(issues(withItems({ idPath: 'a..b' })).join()).toMatch(/empty key/);
      expect(issues(withItems({ namePath: '__proto__' })).join()).toMatch(/not allowed/);
      expect(issues(withItems({ idPath: '' })).join()).toMatch(/Enter a path/);
    });
  });

  describe('Open in link', () => {
    it('allows another HTTPS host than the Base URL', () => {
      expect(issues(withItems({ recordUrl: 'https://app.other.example/d/{id}?tab=1' }))).toEqual([]);
    });

    it.each([
      ['https://app.example.com/devices', /must contain \{id\}/],
      ['https://app.example.com/{id}/{orgId}', /\{id\} only/],
      ['http://app.example.com/{id}', /https/],
      ['https://{id}.example.com/', /host/],
      ['https://u:p@app.example.com/{id}', /user name/],
    ])('refuses %s', (recordUrl, message) => {
      expect(issues(withItems({ recordUrl })).join()).toMatch(message);
    });
  });

  it('refuses a definition over 64 KiB', () => {
    const query = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`q${i}`, i === 0 ? '{cursor}' : 'x'.repeat(1_000)]));
    const fields = Array.from({ length: 64 }, (_, i) => ({ key: `f${i}`, label: 'L'.repeat(80), path: `a${'b'.repeat(200)}`, type: 'TEXT' }));
    const base = definition();
    const big = {
      ...base,
      organizations: { ...base.organizations, request: { path: '/o', query } },
      resources: { items: { ...(base.resources.items as object), fields, request: { path: '/d', query } } },
    };
    expect(issues(big).join()).toMatch(/64 KiB/);
  });

  it('endpoint mode: each resource must be scoped to the organization, by {orgId} or an organization id path', () => {
    const unscoped = withItems({ request: { path: '/api/v1/devices', query: { cursor: '{cursor}' } } });
    expect(issues(unscoped)).toEqual([
      'resources.items.request.path: Each organization needs its own records. Put {orgId} in the request, or set the organization id path.',
    ]);
    expect(issues(withItems({ request: { path: '/api/v1/devices', query: { cursor: '{cursor}' } }, orgIdPath: 'groupId' }))).toEqual([]);
    expect(issues(withItems({ request: { path: '/api/v1/groups/{orgId}/devices', query: { cursor: '{cursor}' } } }))).toEqual([]);
    expect(issues(withItems({ request: { method: 'POST', path: '/api/v1/devices', query: { cursor: '{cursor}' }, body: { filter: { group: '{orgId}' } } } }))).toEqual([]);
    // Single mode has one organization, so no scoping is needed.
    expect(issues({ ...withItems({ request: { path: '/api/v1/devices', query: { cursor: '{cursor}' } } }), organizations: { mode: 'single' } })).toEqual([]);
  });

  it('allows at most 32 query parameters', () => {
    const query = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, i === 0 ? '{cursor}' : 'x']));
    expect(issues(withItems({ request: { path: '/d', query } })).join()).toMatch(/32 query/);
  });
});

describe('customApiRequiredSecretKeys', () => {
  it('lists the auth keys, then one key per secret header', () => {
    const parsed = customApiDefinitionSchema.parse(definition());
    expect(customApiRequiredSecretKeys(parsed)).toEqual(['token', 'header:x-tenant']);
    expect(customApiRequiredSecretKeys({ auth: { method: 'none' }, headers: [] })).toEqual([]);
    expect(customApiRequiredSecretKeys({ auth: { method: 'basic', username: 'u' }, headers: [] })).toEqual(['password']);
    expect(customApiRequiredSecretKeys({ auth: { method: 'header', headerName: 'X-K' }, headers: [] })).toEqual(['value']);
    expect(customApiRequiredSecretKeys({ auth: { method: 'oauth_client_credentials', tokenUrl: 'https://t.example/t', clientAuth: 'body' }, headers: [] }))
      .toEqual(['clientId', 'clientSecret']);
  });
});

describe('customApiTestRequestSchema', () => {
  it('accepts a section test and refuses an unknown section', () => {
    expect(customApiTestRequestSchema.safeParse({ definition: definition(), section: 'items', orgId: 'g1' }).success).toBe(true);
    expect(customApiTestRequestSchema.safeParse({ definition: definition(), section: 'tickets' }).success).toBe(false);
  });
});

describe('limits', () => {
  it('caps synced strings at the detail-card text limit', () => {
    expect(CUSTOM_API_LIMITS.stringValue).toBe(INTEGRATION_SECTION_LIMITS.textLength);
  });
});
