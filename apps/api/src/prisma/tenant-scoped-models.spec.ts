import type { TenantContext } from '@weavestream/shared';
import {
  assertTenantScope,
  TENANT_SCOPED_MODELS,
  TenantScopeViolationError,
} from './tenant-scoped-models.js';

const baseCtx: TenantContext = {
  userId: 'u-1',
  role: 'OPERATOR',
  email: 'op@example.com',
  allowedCompanyIds: ['c-1', 'c-2'],
  isSuperAdmin: false,
  globalAccess: 'NONE',
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'test',
};

const scoped = new Set(['Asset', 'Article']);

describe('assertTenantScope', () => {
  it('passes through models that are not tenant-scoped', () => {
    expect(() =>
      assertTenantScope(
        { model: 'User', action: 'findMany', args: {} },
        baseCtx,
        scoped,
      ),
    ).not.toThrow();
  });

  it('throws when a tenant-scoped query has no companyId filter', () => {
    expect(() =>
      assertTenantScope(
        { model: 'Asset', action: 'findMany', args: { where: {} } },
        baseCtx,
        scoped,
      ),
    ).toThrow(TenantScopeViolationError);
  });

  it('throws when companyId is not in allowedCompanyIds', () => {
    expect(() =>
      assertTenantScope(
        { model: 'Asset', action: 'findMany', args: { where: { companyId: 'other' } } },
        baseCtx,
        scoped,
      ),
    ).toThrow(TenantScopeViolationError);
  });

  it('allows a read with a valid companyId', () => {
    expect(() =>
      assertTenantScope(
        { model: 'Asset', action: 'findMany', args: { where: { companyId: 'c-1' } } },
        baseCtx,
        scoped,
      ),
    ).not.toThrow();
  });

  it('supports companyId.in for reads', () => {
    expect(() =>
      assertTenantScope(
        {
          model: 'Asset',
          action: 'findMany',
          args: { where: { companyId: { in: ['c-1', 'c-2'] } } },
        },
        baseCtx,
        scoped,
      ),
    ).not.toThrow();
  });

  it('rejects companyId.in when any element is out of scope', () => {
    expect(() =>
      assertTenantScope(
        {
          model: 'Asset',
          action: 'findMany',
          args: { where: { companyId: { in: ['c-1', 'nope'] } } },
        },
        baseCtx,
        scoped,
      ),
    ).toThrow(TenantScopeViolationError);
  });

  it('SUPER_ADMIN bypasses read scope but still needs scope for writes', () => {
    const admin: TenantContext = { ...baseCtx, isSuperAdmin: true };
    expect(() =>
      assertTenantScope(
        { model: 'Asset', action: 'findMany', args: { where: {} } },
        admin,
        scoped,
      ),
    ).not.toThrow();
    expect(() =>
      assertTenantScope(
        { model: 'Asset', action: 'create', args: { data: {} } },
        admin,
        scoped,
      ),
    ).toThrow(TenantScopeViolationError);
    expect(() =>
      assertTenantScope(
        { model: 'Asset', action: 'create', args: { data: { companyId: 'anything' } } },
        admin,
        scoped,
      ),
    ).not.toThrow();
  });

  it('writes must carry an in-scope companyId in `data`', () => {
    expect(() =>
      assertTenantScope(
        { model: 'Asset', action: 'create', args: { data: { companyId: 'c-1' } } },
        baseCtx,
        scoped,
      ),
    ).not.toThrow();
    expect(() =>
      assertTenantScope(
        { model: 'Asset', action: 'create', args: { data: { companyId: 'c-99' } } },
        baseCtx,
        scoped,
      ),
    ).toThrow(TenantScopeViolationError);
  });

  it('upserts accept the companyId via `create` or `update`', () => {
    // Typical shape used by the assets service: keyed by a composite
    // unique, scope carried in the payload rather than the `where`.
    expect(() =>
      assertTenantScope(
        {
          model: 'Asset',
          action: 'upsert',
          args: {
            where: { id: 'x' },
            create: { companyId: 'c-1' },
            update: { companyId: 'c-1' },
          },
        },
        baseCtx,
        scoped,
      ),
    ).not.toThrow();
    expect(() =>
      assertTenantScope(
        {
          model: 'Asset',
          action: 'upsert',
          args: { where: { id: 'x' }, create: {}, update: {} },
        },
        baseCtx,
        scoped,
      ),
    ).toThrow(TenantScopeViolationError);
    expect(() =>
      assertTenantScope(
        {
          model: 'Asset',
          action: 'upsert',
          args: {
            where: { id: 'x' },
            create: { companyId: 'c-99' },
            update: { companyId: 'c-99' },
          },
        },
        baseCtx,
        scoped,
      ),
    ).toThrow(TenantScopeViolationError);
  });

  it('createMany scopes every row in its data array', () => {
    expect(() =>
      assertTenantScope(
        {
          model: 'Asset',
          action: 'createMany',
          args: { data: [{ companyId: 'c-1' }, { companyId: 'c-2' }] },
        },
        baseCtx,
        scoped,
      ),
    ).not.toThrow();
    expect(() =>
      assertTenantScope(
        {
          model: 'Asset',
          action: 'createMany',
          args: { data: [{ companyId: 'c-1' }, { companyId: 'c-99' }] },
        },
        baseCtx,
        scoped,
      ),
    ).toThrow(TenantScopeViolationError);
    // One unscoped row fails the whole call even when a sibling row is
    // in scope — an in-scope sibling must not vouch for a row the
    // middleware cannot see.
    expect(() =>
      assertTenantScope(
        {
          model: 'Asset',
          action: 'createMany',
          args: { data: [{ companyId: 'c-1' }, {}] },
        },
        baseCtx,
        scoped,
      ),
    ).toThrow(TenantScopeViolationError);
  });
});

describe('TENANT_SCOPED_MODELS (Phase 3+4 registry)', () => {
  // Phase 3 data-plane and Phase 4 documentation-plane models are both
  // tenant-scoped: every query must name a companyId that the caller is
  // allowed to see. The Phase 4 rows carry a REQUIRED (non-null)
  // companyId — see DECISIONS.md D-010. No carve-outs.
  // Phase 8 adds the domain monitor models on the same footing.
  it.each([
    'Asset',
    'AssetFieldValue',
    'Relation',
    'Article',
    'Folder',
    'Upload',
    'MonitoredDomain',
    'DomainCheck',
    'IntegrationSyncCheckpoint',
    'IntegrationReconstructionSummary',
    'IntegrationReconstructionGap',
  ])('includes %s', (model) => {
    expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
  });

  // AssetLayout / AssetField / Tag are global (see DECISIONS.md D-004
  // and the Tag carve-out next to it). The middleware must NOT force a
  // companyId filter on them, otherwise `GET /layouts` and `GET /tags`
  // would 500 for every operator and client.
  it.each(['AssetLayout', 'AssetField', 'Tag'])(
    'explicitly EXCLUDES %s (global, not tenant-scoped)',
    (model) => {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(false);
    },
  );

  it('does not force company scope on global models even for non-admins', () => {
    // AssetLayout findMany must pass through without a companyId filter —
    // otherwise operators/clients could never read the global catalog.
    expect(() =>
      assertTenantScope(
        { model: 'AssetLayout', action: 'findMany', args: { where: {} } },
        baseCtx,
      ),
    ).not.toThrow();
    expect(() =>
      assertTenantScope(
        { model: 'AssetField', action: 'findMany', args: { where: {} } },
        baseCtx,
      ),
    ).not.toThrow();
    // Same carve-out for the global Tag catalog.
    expect(() =>
      assertTenantScope(
        { model: 'Tag', action: 'findMany', args: { where: {} } },
        baseCtx,
      ),
    ).not.toThrow();
  });

  it('still scopes the data-plane models (Asset) for non-admins', () => {
    expect(() =>
      assertTenantScope(
        { model: 'Asset', action: 'findMany', args: { where: {} } },
        baseCtx,
      ),
    ).toThrow(TenantScopeViolationError);
  });

  it.each(['Article', 'Folder', 'Upload', 'MonitoredDomain', 'DomainCheck'])(
    'requires a companyId filter for %s (no global carve-out)',
    (model) => {
      expect(() =>
        assertTenantScope(
          { model, action: 'findMany', args: { where: {} } },
          baseCtx,
        ),
      ).toThrow(TenantScopeViolationError);
    },
  );
});
