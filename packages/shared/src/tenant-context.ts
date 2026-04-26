import { AsyncLocalStorage } from 'node:async_hooks';
import type { GlobalAccess, UserRole } from './roles.js';

export interface TenantContext {
  userId: string;
  role: UserRole;
  email: string;
  allowedCompanyIds: string[];
  isSuperAdmin: boolean;
  /**
   * Operator-level fallback access to companies the caller has no
   * explicit membership in. `FULL` and `READONLY` widen the tenant
   * scope on reads (and `FULL` on writes); `NONE` and `null` keep the
   * caller pinned to `allowedCompanyIds`.
   */
  globalAccess: GlobalAccess | null;
  requestId: string;
  ip: string;
  userAgent: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'Tenant context missing. This call was made outside an authenticated request.',
    );
  }
  return ctx;
}
