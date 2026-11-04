import type {
  CreateMembershipInput,
  MembershipPasswordAccess,
  UpdateMembershipInput,
} from '@weavestream/shared';

export type MembershipStepUpState = {
  passwordAccess: MembershipPasswordAccess;
  expiresAt: Date | null;
};

/**
 * Whether a membership change needs a fresh step-up. A company password
 * override (`allow` / `deny`) changes who can open password entries, and
 * so does its lifecycle: revoking a `deny` gives access back, and moving
 * the expiry of an `allow` makes it active again. Role-only edits, and any
 * change to an `inherit` membership, do not change password access.
 *
 * `current` is null for a create. The one place this decision is made, so
 * the 3 membership routes cannot drift apart.
 */
export function membershipChangeNeedsStepUp(
  current: MembershipStepUpState | null,
  change: CreateMembershipInput | UpdateMembershipInput | 'revoke',
): boolean {
  if (change === 'revoke') {
    return current !== null && current.passwordAccess !== 'inherit';
  }
  if (current === null) {
    return change.passwordAccess !== undefined && change.passwordAccess !== 'inherit';
  }

  const nextAccess = change.passwordAccess ?? current.passwordAccess;
  if (nextAccess !== current.passwordAccess) return true;

  if (change.expiresAt !== undefined && nextAccess !== 'inherit') {
    const nextExpiry = change.expiresAt === null ? null : new Date(change.expiresAt).getTime();
    const currentExpiry = current.expiresAt === null ? null : current.expiresAt.getTime();
    return nextExpiry !== currentExpiry;
  }
  return false;
}
