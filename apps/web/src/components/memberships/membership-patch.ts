import type { MembershipPasswordAccess, MembershipRole } from '@weavestream/shared';

export type MembershipDraft = {
  role: MembershipRole;
  /** `datetime-local` input value, or '' for no expiry. */
  expiresAtLocal: string;
  passwordAccess: MembershipPasswordAccess;
};

export type MembershipPatch = {
  role?: MembershipRole;
  expiresAt?: string | null;
  passwordAccess?: MembershipPasswordAccess;
};

/** ISO instant → `datetime-local` value in the viewer's time zone. */
export function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value (viewer's time zone) → ISO instant, '' → null. */
export function fromLocalInputValue(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * The PATCH body for a membership edit: only the fields that changed.
 * Sending an unchanged expiry or password access would ask for step-up
 * (and an unchanged past expiry would fail validation), so a role-only
 * edit must send the role alone.
 */
export function membershipPatch(initial: MembershipDraft, draft: MembershipDraft): MembershipPatch {
  const patch: MembershipPatch = {};
  if (draft.role !== initial.role) patch.role = draft.role;
  if (draft.expiresAtLocal !== initial.expiresAtLocal) {
    patch.expiresAt = fromLocalInputValue(draft.expiresAtLocal);
  }
  if (draft.passwordAccess !== initial.passwordAccess) {
    patch.passwordAccess = draft.passwordAccess;
  }
  return patch;
}
