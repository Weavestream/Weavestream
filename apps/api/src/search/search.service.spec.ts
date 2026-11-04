import { SearchService } from './search.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  getTenantContext,
  runWithTenantContext,
  type TenantContext,
} from '@weavestream/shared/server';
import { assertTenantScope } from '../prisma/tenant-scoped-models.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { FULL_PASSWORD_ACCESS, NO_PASSWORD_ACCESS } from '../passwords/password-access-policy.js';

/**
 * Unit tests for the pure helpers inside SearchService that don't
 * need a Postgres instance. The raw tsvector query itself is covered
 * by manual QA + reindex smoke tests — those require a real DB and
 * would drift any in-memory mock quickly.
 *
 * We use `as unknown as SearchService` + bracket access to reach the
 * private methods. Keeping them private in the production type is
 * still valuable (external callers should go through `search()`),
 * and the test contract is narrow enough that this is fine.
 */
describe('SearchService helpers', () => {
  const svc = new SearchService(
    {} as unknown as PrismaService,
  ) as unknown as {
    sanitiseSnippet: (raw: string) => string;
    hrefFor: (
      row: {
        entity_type: 'asset' | 'article' | 'upload' | 'domain' | 'password';
        entity_id: string;
        company_id: string;
      },
      ctx: {
        companySlug: string;
        layoutSlug: string | null;
        articleSlug: string | null;
        isClient: boolean;
      },
    ) => string;
    lastLexeme: (q: string) => string;
  };

  describe('sanitiseSnippet', () => {
    it('escapes HTML entities and preserves only <mark> tags', () => {
      const raw = 'before <mark>target</mark> & <script>bad</script>';
      const cleaned = svc.sanitiseSnippet(raw);
      expect(cleaned).toContain('<mark>target</mark>');
      expect(cleaned).toContain('&amp;');
      expect(cleaned).not.toContain('<script>');
      expect(cleaned).toContain('&lt;script&gt;');
    });

    it('returns empty string when no markers present', () => {
      const cleaned = svc.sanitiseSnippet('plain text');
      expect(cleaned).toBe('plain text');
    });
  });

  describe('hrefFor', () => {
    const assetRow = {
      entity_type: 'asset' as const,
      entity_id: '11111111-1111-1111-1111-111111111111',
      company_id: '22222222-2222-2222-2222-222222222222',
    };
    const articleRow = { ...assetRow, entity_type: 'article' as const };
    const uploadRow = { ...assetRow, entity_type: 'upload' as const };
    const passwordRow = { ...assetRow, entity_type: 'password' as const };

    it('routes operators to admin asset detail URL', () => {
      const href = svc.hrefFor(assetRow, {
        companySlug: 'acme',
        layoutSlug: 'firewall',
        articleSlug: null,
        isClient: false,
      });
      expect(href).toBe(
        '/admin/companies/22222222-2222-2222-2222-222222222222/assets/11111111-1111-1111-1111-111111111111',
      );
    });

    it('routes clients to portal layout page for assets', () => {
      const href = svc.hrefFor(assetRow, {
        companySlug: 'acme',
        layoutSlug: 'firewall',
        articleSlug: null,
        isClient: true,
      });
      expect(href).toBe('/portal/acme/layouts/firewall');
    });

    it('uses article slug for portal article URLs', () => {
      const href = svc.hrefFor(articleRow, {
        companySlug: 'acme',
        layoutSlug: null,
        articleSlug: 'runbook-reboot',
        isClient: true,
      });
      expect(href).toBe('/portal/acme/articles/runbook-reboot');
    });

    it('routes uploads to the photos gallery in both admin and portal', () => {
      expect(
        svc.hrefFor(uploadRow, {
          companySlug: 'acme',
          layoutSlug: null,
          articleSlug: null,
          isClient: false,
        }),
      ).toBe(
        '/admin/companies/22222222-2222-2222-2222-222222222222/photos',
      );
      expect(
        svc.hrefFor(uploadRow, {
          companySlug: 'acme',
          layoutSlug: null,
          articleSlug: null,
          isClient: true,
        }),
      ).toBe('/portal/acme/photos');
    });

    it('routes passwords to admin detail URL for operators', () => {
      const href = svc.hrefFor(passwordRow, {
        companySlug: 'acme',
        layoutSlug: null,
        articleSlug: null,
        isClient: false,
      });
      expect(href).toBe(
        '/admin/companies/22222222-2222-2222-2222-222222222222/passwords/11111111-1111-1111-1111-111111111111',
      );
    });

    it('routes passwords to portal detail URL for clients', () => {
      const href = svc.hrefFor(passwordRow, {
        companySlug: 'acme',
        layoutSlug: null,
        articleSlug: null,
        isClient: true,
      });
      expect(href).toBe(
        '/portal/acme/passwords/11111111-1111-1111-1111-111111111111',
      );
    });
  });

  describe('lastLexeme', () => {
    it('extracts the last token with letters/digits', () => {
      expect(svc.lastLexeme('admin gateway')).toBe('gateway');
      expect(svc.lastLexeme('single')).toBe('single');
    });

    it('returns empty when the last token is too short', () => {
      expect(svc.lastLexeme('foo a')).toBe('');
    });

    it('strips non-alphanumeric characters', () => {
      expect(svc.lastLexeme('router-01')).toBe('router01');
    });
  });
});

/**
 * WS-001: the password allow-list predicate must reach the raw SQL for
 * internal (non-super-admin) users and stay out of it for super admins
 * and client users. We don't run the query — `$queryRaw` is stubbed to
 * return no rows and we assert on the captured `Prisma.Sql` (its
 * flattened `.sql` text and bound `.values`). The real tsvector/array
 * behaviour is covered by the 0051 migration verification against a
 * live database.
 */
const COMPANY_ID = '33333333-3333-3333-3333-333333333333';

function makeActor(role: AuthedUser['role']): AuthedUser {
  return {
    id: '44444444-4444-4444-4444-444444444444',
    email: 'someone@example.com',
    role,
    globalAccess: role === 'OPERATOR' ? 'FULL' : null,
    platformCapabilities: [],
    sessionId: 'session-1',
    mfaEnforcementCompletedAt: null,
    mfaPending: false,
    passwordAccess: FULL_PASSWORD_ACCESS,
  } as AuthedUser;
}

function makeCtx(
  actor: AuthedUser,
  allowedCompanyIds: string[] = [COMPANY_ID],
): TenantContext {
  return {
    userId: actor.id,
    role: actor.role,
    email: actor.email,
    allowedCompanyIds,
    isSuperAdmin: actor.role === 'SUPER_ADMIN',
    globalAccess: actor.globalAccess,
    requestId: 'req-1',
    ip: '127.0.0.1',
    userAgent: 'jest',
  };
}

function makeService() {
  const queryRaw = jest.fn(async () => []);
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  return { svc: new SearchService(prisma), queryRaw };
}

function capturedSql(queryRaw: jest.Mock): {
  sql: string;
  values: unknown[];
} {
  expect(queryRaw).toHaveBeenCalledTimes(1);
  const arg = queryRaw.mock.calls[0][0] as {
    sql: string;
    values: unknown[];
  };
  return { sql: arg.sql, values: arg.values };
}

describe('SearchService password allow-list filter', () => {
  async function runSearch(actor: AuthedUser) {
    const { svc, queryRaw } = makeService();
    await runWithTenantContext(makeCtx(actor), () =>
      svc.search(actor, { q: 'gateway' }),
    );
    return capturedSql(queryRaw);
  }

  it('applies the allow-list predicate for operators', async () => {
    const actor = makeActor('OPERATOR');
    const { sql, values } = await runSearch(actor);
    expect(sql).toContain('restricted_to_user_ids');
    expect(sql).toContain("si.entity_type <> 'password'");
    expect(values).toContain(actor.id);
  });

  it('applies the allow-list predicate for contractors', async () => {
    const actor = makeActor('CONTRACTOR');
    const { sql, values } = await runSearch(actor);
    expect(sql).toContain('restricted_to_user_ids');
    expect(values).toContain(actor.id);
  });

  it('omits the allow-list predicate for super admins', async () => {
    const actor = makeActor('SUPER_ADMIN');
    const { sql } = await runSearch(actor);
    expect(sql).not.toContain('restricted_to_user_ids');
  });

  it('omits the allow-list predicate for client users but keeps the visibility gate', async () => {
    const actor = makeActor('CLIENT_USER');
    const { sql } = await runSearch(actor);
    expect(sql).not.toContain('restricted_to_user_ids');
    expect(sql).toContain('si.visible_to_clients = true');
  });

  it('binds the global password policy result as a parameter (issue #110)', async () => {
    const inside = await runSearch(makeActor('OPERATOR'));
    expect(inside.sql).toContain("si.restricted_to_user_ids = '{}'::uuid[] AND");
    expect(inside.sql).toContain('::boolean');
    expect(inside.values).toContain(true);
    expect(inside.values).not.toContain(false);

    const outsider = { ...makeActor('OPERATOR'), passwordAccess: NO_PASSWORD_ACCESS };
    const out = await runSearch(outsider);
    expect(out.values).toContain(false);
    // Never string-built into the SQL text.
    expect(out.sql).not.toMatch(/\b(true|false)::boolean/);
  });

  it('binds membership override company ids as uuid arrays, never as SQL text', async () => {
    const DENIED = '99999999-9999-4999-8999-999999999999';
    const ALLOWED = '88888888-8888-4888-8888-888888888888';
    const actor = {
      ...makeActor('OPERATOR'),
      passwordAccess: { byDefault: true, allowCompanyIds: [ALLOWED], denyCompanyIds: [DENIED] },
    };
    const { sql, values } = await runSearch(actor);
    expect(sql).toContain('::uuid[]');
    expect(sql).toContain('CASE WHEN');
    expect(sql).toContain('si.company_id = ANY(');
    expect(sql).toContain('p.company_id = ANY(');
    expect(sql).not.toContain(DENIED);
    expect(sql).not.toContain(ALLOWED);
    // Password branch + upload branch each bind both lists.
    expect(values.filter((v) => Array.isArray(v) && v.includes(DENIED))).toHaveLength(2);
    expect(values.filter((v) => Array.isArray(v) && v.includes(ALLOWED))).toHaveLength(2);
    expect(sql).not.toMatch(/\b(true|false)::boolean/);
  });

  it('hides files attached to a password entry the actor cannot open', async () => {
    const actor = makeActor('OPERATOR');
    const { sql, values } = await runSearch(actor);
    expect(sql).toContain("si.entity_type <> 'upload' OR NOT EXISTS");
    expect(sql).toContain("u.attached_to_type = 'password'");
    expect(sql).toContain('JOIN passwords p ON p.id = u.attached_to_id');
    expect(values.filter((v) => v === actor.id).length).toBeGreaterThanOrEqual(2);
  });

  it('does not add the upload filter for super admins', async () => {
    const { sql } = await runSearch(makeActor('SUPER_ADMIN'));
    expect(sql).not.toContain('attached_to_type');
  });

  it('mentions() delegates through search() with the predicate for operators', async () => {
    const actor = makeActor('OPERATOR');
    const { svc, queryRaw } = makeService();
    await runWithTenantContext(makeCtx(actor), () =>
      svc.mentions(actor, 'gateway', { companyId: COMPANY_ID }),
    );
    const { sql, values } = capturedSql(queryRaw);
    expect(sql).toContain('restricted_to_user_ids');
    expect(values).toContain(actor.id);
  });
});

/**
 * Phase 5b "server contracts first" pins: cross-org scope is derived
 * from the tenant context, NEVER from request input, and cross-org
 * (unpinned) searches exclude hits living in archived companies. Same
 * SQL-capture harness as the allow-list suite above.
 */
describe('SearchService cross-org scope', () => {
  it('scopes an omitted companyId to the tenant allow-list for non-global actors', async () => {
    // CONTRACTOR carries globalAccess null — the membership-scoped class.
    const actor = makeActor('CONTRACTOR');
    const { svc, queryRaw } = makeService();
    await runWithTenantContext(makeCtx(actor), () => svc.search(actor, { q: 'gateway' }));
    const { sql, values } = capturedSql(queryRaw);
    expect(sql).toContain('si.company_id IN');
    expect(values).toContain(COMPANY_ID);
  });

  it('returns empty without querying when the allowed set is empty', async () => {
    const actor = makeActor('CONTRACTOR');
    const { svc, queryRaw } = makeService();
    const res = await runWithTenantContext(makeCtx(actor, []), () =>
      svc.search(actor, { q: 'gateway' }),
    );
    expect(res.items).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('returns empty without querying for an out-of-scope explicit companyId', async () => {
    const actor = makeActor('CONTRACTOR');
    const { svc, queryRaw } = makeService();
    const res = await runWithTenantContext(makeCtx(actor), () =>
      svc.search(actor, {
        q: 'gateway',
        companyId: '99999999-9999-9999-9999-999999999999',
      }),
    );
    expect(res.items).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('emits no company predicate for a global actor with companyId omitted', async () => {
    const actor = makeActor('OPERATOR'); // globalAccess FULL
    const { svc, queryRaw } = makeService();
    await runWithTenantContext(makeCtx(actor), () => svc.search(actor, { q: 'gateway' }));
    const { sql } = capturedSql(queryRaw);
    expect(sql).not.toContain('si.company_id IN');
  });
});

describe('SearchService archived-company exclusion (cross-org mode)', () => {
  const ARCHIVED_PREDICATE = 'c.archived_at IS NOT NULL';

  async function runSearch(actor: AuthedUser, companyId?: string) {
    const { svc, queryRaw } = makeService();
    await runWithTenantContext(makeCtx(actor), () =>
      svc.search(actor, { q: 'gateway', ...(companyId ? { companyId } : {}) }),
    );
    return capturedSql(queryRaw);
  }

  it.each(['OPERATOR', 'SUPER_ADMIN', 'CONTRACTOR', 'CLIENT_USER'] as const)(
    'applies the archived-company predicate for %s when companyId is omitted',
    async (role) => {
      const { sql } = await runSearch(makeActor(role));
      expect(sql).toContain(ARCHIVED_PREDICATE);
    },
  );

  it('omits the predicate when a company is explicitly pinned', async () => {
    const { sql } = await runSearch(makeActor('OPERATOR'), COMPANY_ID);
    expect(sql).not.toContain(ARCHIVED_PREDICATE);
  });

  it('stays independent of includeArchived (entity-level flag ≠ offboarded client)', async () => {
    const actor = makeActor('OPERATOR');
    const { svc, queryRaw } = makeService();
    await runWithTenantContext(makeCtx(actor), () =>
      svc.search(actor, { q: 'gateway', includeArchived: true }),
    );
    const { sql } = capturedSql(queryRaw);
    expect(sql).toContain(ARCHIVED_PREDICATE);
    expect(sql).not.toContain('si.archived_at IS NULL');
  });

  it('mentions() with a pinned company delegates without the predicate', async () => {
    const actor = makeActor('OPERATOR');
    const { svc, queryRaw } = makeService();
    await runWithTenantContext(makeCtx(actor), () =>
      svc.mentions(actor, 'gateway', { companyId: COMPANY_ID }),
    );
    const { sql } = capturedSql(queryRaw);
    expect(sql).not.toContain(ARCHIVED_PREDICATE);
  });
});

/**
 * Hit enrichment reads Article and Upload, which are tenant-scoped
 * models. For an operator pinned to their memberships (globalAccess
 * NONE) the Prisma tenant middleware rejects any read without a
 * `companyId` filter, so a search that matched an article returned 500.
 * The stub runs the real `assertTenantScope` rule on each read.
 */
describe('SearchService hit enrichment under tenant scope', () => {
  const ARTICLE_ID = '55555555-5555-5555-5555-555555555555';
  const UPLOAD_ID = '66666666-6666-6666-6666-666666666666';

  function makeEnrichService() {
    const row = (entity_type: string, entity_id: string) => ({
      entity_type,
      entity_id,
      company_id: COMPANY_ID,
      title: entity_type,
      snippet: '',
      layout_id: null,
      archived_at: null,
      updated_at: new Date('2026-11-04T00:00:00Z'),
      score: 1,
    });
    const scoped = (model: string) =>
      jest.fn(async (args: Record<string, unknown>) => {
        assertTenantScope({ model, action: 'findMany', args }, getTenantContext()!);
        return [];
      });
    const prisma = {
      $queryRaw: jest.fn(async () => [row('article', ARTICLE_ID), row('upload', UPLOAD_ID)]),
      company: { findMany: jest.fn(async () => []) },
      assetLayout: { findMany: jest.fn(async () => []) },
      article: { findMany: scoped('Article') },
      upload: { findMany: scoped('Upload') },
    };
    return { svc: new SearchService(prisma as unknown as PrismaService), prisma };
  }

  it('scopes article and upload reads by the hit company ids for a membership-pinned operator', async () => {
    const actor = { ...makeActor('OPERATOR'), globalAccess: 'NONE' } as AuthedUser;
    const { svc, prisma } = makeEnrichService();

    const res = await runWithTenantContext(makeCtx(actor), () =>
      svc.search(actor, { q: 'microsoft', companyId: COMPANY_ID }),
    );

    expect(res.items.map((i) => i.kind)).toEqual(['article', 'upload']);
    expect(prisma.article.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [ARTICLE_ID] }, companyId: { in: [COMPANY_ID] } },
      }),
    );
    expect(prisma.upload.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [UPLOAD_ID] }, companyId: { in: [COMPANY_ID] } },
      }),
    );
  });
});
