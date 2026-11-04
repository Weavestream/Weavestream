import { getTenantContext, runWithTenantContext, type TenantContext } from '@weavestream/shared/server';
import { runInCompanyScope } from './company-scope.js';

const CTX: TenantContext = {
  userId: 'u-1',
  role: 'OPERATOR',
  email: 'op@example.test',
  allowedCompanyIds: ['c-member'],
  isSuperAdmin: false,
  globalAccess: 'NONE',
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

describe('runInCompanyScope', () => {
  it('sets the scope to exactly the given companies inside the block', async () => {
    const seen = await runWithTenantContext(CTX, () =>
      runInCompanyScope(['c-a', 'c-b'], async () => getTenantContext()),
    );
    expect(seen).toEqual({ ...CTX, allowedCompanyIds: ['c-a', 'c-b'] });
  });

  it('restores the caller scope after the block', async () => {
    const after = await runWithTenantContext(CTX, async () => {
      await runInCompanyScope(['c-a'], async () => undefined);
      return getTenantContext();
    });
    expect(after?.allowedCompanyIds).toEqual(['c-member']);
  });

  it('keeps role and bypass flags unchanged', async () => {
    const seen = await runWithTenantContext(CTX, () =>
      runInCompanyScope(['c-a'], async () => getTenantContext()),
    );
    expect(seen?.isSuperAdmin).toBe(false);
    expect(seen?.globalAccess).toBe('NONE');
  });

  it('runs the block unchanged with no tenant context (CLI, worker)', async () => {
    await expect(runInCompanyScope(['c-a'], async () => getTenantContext())).resolves.toBeUndefined();
  });
});
