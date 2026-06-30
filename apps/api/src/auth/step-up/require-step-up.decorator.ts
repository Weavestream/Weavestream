import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export const REQUIRE_STEP_UP_KEY = 'auth:require_step_up';

export interface RequireStepUpMetadata {
  /**
   * Optional predicate deciding whether THIS request needs step-up.
   * Returning `false` skips the challenge — e.g. a user PATCH that only
   * changes a display name, or an export that omits plaintext passwords.
   *
   * IMPORTANT: NestJS runs guards BEFORE validation pipes, so `req.body`
   * here is the raw express-parsed JSON — Zod defaults have NOT been
   * applied yet. Optional-chain every access and compare explicitly
   * (`req.body?.includePasswords === true`); never assume a schema
   * default would have filled a field in.
   */
  when?: (req: Request) => boolean | Promise<boolean>;
}

/**
 * Marks a route as requiring a recent step-up (re-authentication)
 * confirmation in addition to its `@RequirePermission()` gate.
 *
 * The global `StepUpGuard` enforces this AFTER `PermissionGuard`, so by
 * the time it runs the caller is already authorized for the action —
 * step-up is a fresh second factor layered on top, never a substitute
 * for RBAC. A route with no `@RequireStepUp()` is never challenged.
 */
export const RequireStepUp = (options: RequireStepUpMetadata = {}) =>
  SetMetadata(REQUIRE_STEP_UP_KEY, options);
