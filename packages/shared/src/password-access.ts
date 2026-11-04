/**
 * Company-aware password access — the part of the rule that the API and
 * the web share. Framework-free on purpose.
 *
 * Order (most specific wins):
 *   1. An entry with its own allow-list uses only that list (API only).
 *   2. An active membership with `allow` / `deny` for the entry's company.
 *   3. Otherwise the global password access policy (`byDefault`).
 * Super admins always pass and client users follow `visibleToClients`;
 * the API's role branches handle both before this scope is consulted.
 */

export const membershipPasswordAccessValues = ['inherit', 'allow', 'deny'] as const;
export type MembershipPasswordAccess = (typeof membershipPasswordAccessValues)[number];

export const MEMBERSHIP_PASSWORD_ACCESS_LABELS: Record<MembershipPasswordAccess, string> = {
  inherit: 'Use global policy',
  allow: 'Allow',
  deny: 'Deny',
};

/** Stored values are free-form text; anything unknown is treated as `inherit`. */
export function readMembershipPasswordAccess(value: unknown): MembershipPasswordAccess {
  return value === 'allow' || value === 'deny' ? value : 'inherit';
}

export type PasswordAccessScope = {
  /** Result of the global password access policy for this user. */
  byDefault: boolean;
  /** Companies where an active membership says `allow`. */
  allowCompanyIds: readonly string[];
  /** Companies where an active membership says `deny`. */
  denyCompanyIds: readonly string[];
};

/** Whether the user may open entries without their own list in `companyId`. */
export function passwordAccessForCompany(scope: PasswordAccessScope, companyId: string): boolean {
  if (scope.denyCompanyIds.includes(companyId)) return false;
  if (scope.allowCompanyIds.includes(companyId)) return true;
  return scope.byDefault;
}
