import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Action } from './permissions.js';

export const REQUIRE_PERMISSION_KEY = 'rbac:require_permission';
export const AUTHED_ONLY_KEY = 'rbac:authed_only';

export type CompanyIdSource =
  | 'params.id'
  | 'params.companyId'
  | 'body.companyId'
  | 'query.companyId'
  | ((req: Request) => string | undefined | Promise<string | undefined>);

export interface RequirePermissionMetadata {
  action: Action;
  companyIdFrom?: CompanyIdSource;
}

/**
 * Declares the action this handler performs. The global PermissionGuard
 * reads this metadata on every request and calls PermissionService.can.
 * Default-deny: any non-@Public() route without either
 * @RequirePermission() or @AuthedOnly() is rejected.
 */
export const RequirePermission = (
  action: Action,
  options: { companyIdFrom?: CompanyIdSource } = {},
) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, {
    action,
    companyIdFrom: options.companyIdFrom,
  } satisfies RequirePermissionMetadata);

/**
 * Opt-out of the permission check. Route still requires a valid session
 * and MFA — use this only for routes like `/auth/me` and `/me` where the
 * resource is implicitly scoped to the caller.
 */
export const AuthedOnly = () => SetMetadata(AUTHED_ONLY_KEY, true);
