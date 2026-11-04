'use client';

import {
  MEMBERSHIP_PASSWORD_ACCESS_LABELS,
  membershipPasswordAccessValues,
  type MembershipPasswordAccess,
} from '@weavestream/shared';
import { Field, Select, Tag } from '../ui';

const HELP: Record<MembershipPasswordAccess, string> = {
  inherit: 'The global password access policy decides.',
  allow: 'Can open password entries in this company, even if the global policy excludes them.',
  deny: 'Cannot open password entries in this company, even if the global policy includes them.',
};

/**
 * Company-level password access override for one membership. Shared by
 * the company Members page and the user detail page. Hidden for client
 * users: their access follows "visible to clients" only, and the API
 * refuses an override for them.
 */
export function PasswordAccessField({
  id,
  value,
  onChange,
  userRole,
  expiresAtLocal,
  disabled,
}: {
  id: string;
  value: MembershipPasswordAccess;
  onChange: (next: MembershipPasswordAccess) => void;
  userRole: string | undefined;
  /** The membership's expiry as typed in the dialog ('' = none). */
  expiresAtLocal: string;
  disabled?: boolean;
}) {
  if (userRole === 'CLIENT_USER') return null;
  return (
    <Field
      label="Password access"
      htmlFor={id}
      help={`${HELP[value]} An entry with its own access list still uses only that list.`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as MembershipPasswordAccess)}
        >
          {membershipPasswordAccessValues.map((v) => (
            <option key={v} value={v}>
              {MEMBERSHIP_PASSWORD_ACCESS_LABELS[v]}
            </option>
          ))}
        </Select>
        {value === 'deny' && expiresAtLocal && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--warn)', lineHeight: 1.45 }}>
            When this membership expires, the user&apos;s password access comes back from the
            global policy.
          </p>
        )}
        {value !== 'inherit' && userRole === 'OPERATOR' && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
            If this operator has global access, this membership also sets their role in this
            company.
          </p>
        )}
      </div>
    </Field>
  );
}

/** Table / card display of a membership's password access override. */
export function PasswordAccessTag({ value }: { value: MembershipPasswordAccess }) {
  if (value === 'allow') return <Tag tone="ok">Allow</Tag>;
  if (value === 'deny') return <Tag tone="danger">Deny</Tag>;
  return <span style={{ color: 'var(--dim)', fontSize: 12 }}>Global</span>;
}
