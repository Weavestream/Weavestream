import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRole } from './roles.js';

export interface TenantContext {
  userId: string;
  role: UserRole;
  email: string;
  allowedCompanyIds: string[];
  isSuperAdmin: boolean;
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
