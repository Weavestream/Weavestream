import type { TenantContext } from '@weavestream/shared';
import {
  EntityScopeService,
  hasGlobalReadScope,
  scopedCompanyLookupWhere,
} from './entity-scope.js';

function ctx(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    userId: 'u-1',
    role: 'OPERATOR',
    email: 'op@example.com',
    allowedCompanyIds: ['c-1', 'c-2'],
    isSuperAdmin: false,
    globalAccess: null,
    requestId: 'req-1',
    ip: '127.0.0.1',
    userAgent: 'jest',
    ...overrides,
  };
}

describe('scopedCompanyLookupWhere', () => {
  it('queries by id alone for read-bypass actors', () => {
    expect(scopedCompanyLookupWhere(ctx({ isSuperAdmin: true }), 'e-1')).toEqual({
      id: 'e-1',
    });
    expect(scopedCompanyLookupWhere(ctx({ globalAccess: 'READONLY' }), 'e-1')).toEqual({
      id: 'e-1',
    });
    expect(scopedCompanyLookupWhere(ctx({ globalAccess: 'FULL' }), 'e-1')).toEqual({
      id: 'e-1',
    });
  });

  it('pins membership-scoped actors to companyId IN allowedCompanyIds', () => {
    expect(scopedCompanyLookupWhere(ctx(), 'e-1')).toEqual({
      id: 'e-1',
      companyId: { in: ['c-1', 'c-2'] },
    });
    expect(scopedCompanyLookupWhere(ctx({ globalAccess: 'NONE' }), 'e-1')).toEqual({
      id: 'e-1',
      companyId: { in: ['c-1', 'c-2'] },
    });
  });

  it('short-circuits to null for an actor with zero memberships (a `{ in: [] }` filter would trip the tenant middleware)', () => {
    expect(scopedCompanyLookupWhere(ctx({ allowedCompanyIds: [] }), 'e-1')).toBeNull();
  });
});

describe('hasGlobalReadScope', () => {
  it('true for SUPER_ADMIN and FULL/READONLY globalAccess, false otherwise', () => {
    expect(hasGlobalReadScope(ctx({ isSuperAdmin: true }))).toBe(true);
    expect(hasGlobalReadScope(ctx({ globalAccess: 'FULL' }))).toBe(true);
    expect(hasGlobalReadScope(ctx({ globalAccess: 'READONLY' }))).toBe(true);
    expect(hasGlobalReadScope(ctx({ globalAccess: 'NONE' }))).toBe(false);
    expect(hasGlobalReadScope(ctx())).toBe(false);
  });
});

describe('EntityScopeService.resolveEntityCompany', () => {
  function makePrisma() {
    return {
      asset: { findFirst: jest.fn(async () => null as { companyId: string } | null) },
      article: { findFirst: jest.fn(async () => null as { companyId: string } | null) },
      password: { findFirst: jest.fn(async () => null as { companyId: string } | null) },
    };
  }

  it('membership-scoped lookups literally carry the IN filter in the WHERE', async () => {
    const prisma = makePrisma();
    prisma.article.findFirst.mockResolvedValueOnce({ companyId: 'c-2' });
     
    const svc = new EntityScopeService(prisma as any);
    const resolved = await svc.resolveEntityCompany(ctx(), 'article', 'e-9');
    expect(resolved).toBe('c-2');
    expect(prisma.article.findFirst).toHaveBeenCalledWith({
      where: { id: 'e-9', companyId: { in: ['c-1', 'c-2'] } },
      select: { companyId: true },
    });
  });

  it('read-bypass lookups query by id alone', async () => {
    const prisma = makePrisma();
    prisma.password.findFirst.mockResolvedValueOnce({ companyId: 'c-7' });
     
    const svc = new EntityScopeService(prisma as any);
    const resolved = await svc.resolveEntityCompany(
      ctx({ isSuperAdmin: true }),
      'password',
      'e-9',
    );
    expect(resolved).toBe('c-7');
    expect(prisma.password.findFirst).toHaveBeenCalledWith({
      where: { id: 'e-9' },
      select: { companyId: true },
    });
  });

  it('empty memberships resolve to null WITHOUT querying', async () => {
    const prisma = makePrisma();
     
    const svc = new EntityScopeService(prisma as any);
    const resolved = await svc.resolveEntityCompany(
      ctx({ allowedCompanyIds: [] }),
      'asset',
      'e-9',
    );
    expect(resolved).toBeNull();
    expect(prisma.asset.findFirst).not.toHaveBeenCalled();
  });

  it('out-of-scope rows resolve to null for membership-scoped actors (no existence signal)', async () => {
    const prisma = makePrisma();
    // The stub returns null because the IN filter excludes the row's
    // company — exactly what Postgres would do.
     
    const svc = new EntityScopeService(prisma as any);
    const resolved = await svc.resolveEntityCompany(ctx(), 'asset', 'other-tenant-id');
    expect(resolved).toBeNull();
  });
});
