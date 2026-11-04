import { getTenantContext, runWithTenantContext } from '@weavestream/shared/server';

/**
 * Run `fn` with the tenant scope set to exactly `companyIds`.
 *
 * For handlers authorized by a GLOBAL platform capability
 * (`INTEGRATION_MANAGE`, `LAYOUT_MANAGE`, `COMPANY_MANAGE`, ...) whose
 * work reaches tenant-scoped rows the caller has no membership on. The
 * tenant middleware stays active: every query inside `fn` still needs a
 * `companyId` filter, and that filter must fall inside `companyIds`.
 *
 * Rules for callers:
 *  - Call only after the handler's `@RequirePermission` check for that
 *    global capability. This helper is not an authorization check.
 *  - Derive `companyIds` server-side from that authorized scope. Never
 *    pass a client-supplied list the capability does not cover.
 *  - Pass the narrowest list the work needs. An empty list gives no
 *    scope: the middleware rejects every scoped query.
 *
 * With no tenant context (CLI, worker) `fn` runs unchanged.
 */
export function runInCompanyScope<T>(companyIds: string[], fn: () => Promise<T>): Promise<T> {
  const tenant = getTenantContext();
  if (!tenant) return fn();
  return runWithTenantContext({ ...tenant, allowedCompanyIds: companyIds }, fn);
}
