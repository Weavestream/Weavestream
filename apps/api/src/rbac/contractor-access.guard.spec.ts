import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ContractorAccessGuard } from './contractor-access.guard.js';
import { REQUIRE_PERMISSION_KEY } from './require-permission.decorator.js';
import type { MembershipSnapshot, PermissionService } from './permission.service.js';

function makeCtx(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as ExecutionContext;
}

function makeGuard(memberships: MembershipSnapshot[], companyIdFrom: string | null = 'params.id') {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key) =>
      key === REQUIRE_PERMISSION_KEY ? (companyIdFrom ? { companyIdFrom } : undefined) : undefined,
    );
  const permissions = {
    loadMemberships: jest.fn().mockResolvedValue(memberships),
  } as unknown as PermissionService;
  return new ContractorAccessGuard(reflector, permissions);
}

describe('ContractorAccessGuard', () => {
  const COMPANY = 'c-1';

  it('short-circuits for non-contractors', async () => {
    const g = makeGuard([]);
    const ok = await g.canActivate(
      makeCtx({ user: { role: 'OPERATOR' }, params: { id: COMPANY } }),
    );
    expect(ok).toBe(true);
  });

  it('short-circuits when no permission metadata declares a companyIdFrom', async () => {
    const g = makeGuard([], null);
    const ok = await g.canActivate(
      makeCtx({ user: { id: 'u', role: 'CONTRACTOR' }, params: { id: COMPANY } }),
    );
    expect(ok).toBe(true);
  });

  it('blocks contractors with no membership', async () => {
    const g = makeGuard([]);
    await expect(
      g.canActivate(
        makeCtx({ user: { id: 'u', role: 'CONTRACTOR' }, params: { id: COMPANY } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks contractors with expired membership', async () => {
    const g = makeGuard([
      {
        companyId: COMPANY,
        role: 'READONLY',
        expiresAt: new Date('2000-01-01'),
        revokedAt: null,
      },
    ]);
    await expect(
      g.canActivate(
        makeCtx({ user: { id: 'u', role: 'CONTRACTOR' }, params: { id: COMPANY } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks contractors with revoked membership', async () => {
    const g = makeGuard([
      {
        companyId: COMPANY,
        role: 'READONLY',
        expiresAt: null,
        revokedAt: new Date(),
      },
    ]);
    await expect(
      g.canActivate(
        makeCtx({ user: { id: 'u', role: 'CONTRACTOR' }, params: { id: COMPANY } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows contractors with live membership', async () => {
    const g = makeGuard([
      {
        companyId: COMPANY,
        role: 'READONLY',
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
      },
    ]);
    const ok = await g.canActivate(
      makeCtx({ user: { id: 'u', role: 'CONTRACTOR' }, params: { id: COMPANY } }),
    );
    expect(ok).toBe(true);
  });
});
