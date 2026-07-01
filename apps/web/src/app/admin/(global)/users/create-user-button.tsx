'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  GlobalAccess,
  MembershipRole,
  PlatformCapability,
  UserRole,
} from '@weavestream/shared';
import {
  GlobalAccessValues,
  MANAGER_PRESET,
  PlatformCapabilityValues,
} from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { FormattedDateTime } from '../../../../lib/timezone-context';
import {
  Btn,
  CompanyPicker,
  Dialog,
  Field,
  Icon,
  Input,
  Select,
  Tag,
  useToast,
  type CompanyPickerValue,
} from '../../../../components/ui';
import {
  capabilityLabel,
  globalAccessLabel,
  membershipRoleLabel,
  roleLabel,
} from '../../../../lib/roles';
import { capitalize } from '../../../../lib/term';
import { useTerm } from '../../../../lib/term-context';

const ROLES: UserRole[] = [
  'SUPER_ADMIN',
  'OPERATOR',
  'CONTRACTOR',
  'CLIENT_USER',
];

const MEMBERSHIP_ROLES: MembershipRole[] = ['FULL', 'READONLY'];

/**
 * CLIENT_USER memberships are pinned to READONLY at the API tier
 * (see memberships.service `CLIENT_USER memberships must be READONLY`).
 * The other global roles can pick either.
 */
function membershipRolesFor(role: UserRole): MembershipRole[] {
  return role === 'CLIENT_USER' ? ['READONLY'] : MEMBERSHIP_ROLES;
}

/**
 * Global roles that are meant to *need* a company assignment to do
 * anything useful. SUPER_ADMIN has global access and OPERATOR can rely
 * on `globalAccess`, so those don't auto-show the attach panel — the
 * operator creating them can still expand it manually via the toggle.
 * CLIENT_USER is locked to READONLY at the API tier; CONTRACTOR is
 * always READONLY in practice.
 */
const DEFAULT_MEMBERSHIP_ROLES: Record<UserRole, MembershipRole> = {
  SUPER_ADMIN: 'FULL',
  OPERATOR: 'FULL',
  CONTRACTOR: 'READONLY',
  CLIENT_USER: 'READONLY',
};

function defaultShowMembership(role: UserRole): boolean {
  return role === 'CLIENT_USER' || role === 'CONTRACTOR';
}

type CreateResponse = {
  user: { id: string; email: string; name: string; role: UserRole };
  setupUrl: string;
  expiresAt: string;
  membership: {
    id: string;
    role: MembershipRole;
    companyId: string;
    expiresAt: string | null;
  } | null;
};

export interface CreateUserButtonProps {
  /**
   * When provided the dialog opens in "invite into this company" mode:
   * the attach panel is expanded by default, the company field is
   * pre-filled, and the default global role flips to CLIENT_USER.
   * Used by the company → Users tab for the one-step onboarding flow.
   */
  defaultCompany?: CompanyPickerValue | null;
  /**
   * Override the trigger label. Defaults to "New user" for the global
   * users page; the company page passes "Invite new user" to
   * differentiate from "Add member".
   */
  triggerLabel?: string;
  /**
   * Pass `'outline'` on surfaces where the primary-style button would
   * compete with a sibling primary.
   */
  triggerKind?: 'primary' | 'outline' | 'ghost';
  triggerSize?: 'sm' | 'md';
  onCreated?: () => void;
}

export function CreateUserButton({
  defaultCompany,
  triggerLabel,
  triggerKind = 'primary',
  triggerSize = 'md',
  onCreated,
}: CreateUserButtonProps = {}) {
  const router = useRouter();
  const toast = useToast();
  const term = useTerm();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('CLIENT_USER');

  // Attach-panel state is independent of the user fields so it can be
  // toggled open/closed without losing in-progress edits.
  const [attachOpen, setAttachOpen] = useState(!!defaultCompany);
  const [attachCompany, setAttachCompany] = useState<CompanyPickerValue | null>(
    defaultCompany ?? null,
  );
  const [attachRole, setAttachRole] = useState<MembershipRole>('READONLY');
  const [attachExpiresAt, setAttachExpiresAt] = useState('');

  // Operator-only axes: default platform access for companies the user
  // has no membership for, plus delegated platform capabilities. Both
  // are sent only when the global role is OPERATOR; the API rejects
  // them on every other role.
  const [globalAccess, setGlobalAccess] = useState<GlobalAccess>('FULL');
  const [capabilities, setCapabilities] = useState<PlatformCapability[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CreateResponse | null>(null);

  const lockedCompany = useMemo(() => !!defaultCompany, [defaultCompany]);
  const canSubmit =
    email.trim().length > 0 &&
    name.trim().length > 0 &&
    (!attachOpen || !!attachCompany);

  // When the caller changes the default company (e.g. navigating
  // between company pages with the dialog still mounted) reset local
  // state so we don't attach to the wrong company.
  useEffect(() => {
    if (defaultCompany) {
      setAttachOpen(true);
      setAttachCompany(defaultCompany);
      setRole('CLIENT_USER');
      setAttachRole('READONLY');
    }
  }, [defaultCompany?.id]);

  function reset() {
    setEmail('');
    setName('');
    setRole('CLIENT_USER');
    setError(null);
    setResult(null);
    setAttachOpen(!!defaultCompany);
    setAttachCompany(defaultCompany ?? null);
    setAttachRole('READONLY');
    setAttachExpiresAt('');
    setGlobalAccess('FULL');
    setCapabilities([]);
  }

  async function submit() {
    setError(null);
    setPending(true);
    const body: Record<string, unknown> = { email, name, role };
    if (role === 'OPERATOR') {
      body.globalAccess = globalAccess;
      body.platformCapabilities = capabilities;
    }
    if (attachOpen && attachCompany) {
      body.membership = {
        companyId: attachCompany.id,
        role: attachRole,
        ...(attachExpiresAt
          ? { expiresAt: new Date(attachExpiresAt).toISOString() }
          : {}),
      };
    }
    const res = await apiFetch<CreateResponse>('/users', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as { detail?: string; title?: string } | undefined;
      setError(problem?.detail ?? problem?.title ?? 'Could not create user.');
      return;
    }
    setResult(res.data);
    router.refresh();
    onCreated?.();
  }

  function copySetupLink() {
    if (!result) return;
    navigator.clipboard
      .writeText(result.setupUrl)
      .then(() => toast.push('Setup link copied to clipboard.', 'ok'))
      .catch(() => toast.push('Could not copy link.', 'danger'));
  }

  const attachedCompanyName = attachCompany?.name ?? null;

  return (
    <>
      <Btn
        kind={triggerKind}
        size={triggerSize}
        icon={Icon.plus}
        onClick={() => setOpen(true)}
      >
        {triggerLabel ?? 'New user'}
      </Btn>
      <Dialog
        open={open}
        onClose={() => {
          if (!pending) {
            setOpen(false);
            reset();
          }
        }}
        title={result ? 'Share setup link' : defaultCompany ? 'Invite new user' : 'Create user'}
        width={520}
        footer={
          result ? (
            <>
              <Btn kind="ghost" onClick={() => router.push(`/admin/users/${result.user.id}`)}>
                View user
              </Btn>
              <Btn
                kind="primary"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Done
              </Btn>
            </>
          ) : (
            <>
              <Btn
                kind="ghost"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                disabled={pending}
              >
                Cancel
              </Btn>
              <Btn
                kind="primary"
                onClick={submit}
                loading={pending}
                disabled={!canSubmit}
              >
                Create &amp; generate link
              </Btn>
            </>
          )
        }
      >
        {result ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: 'var(--text-2)',
                lineHeight: 1.5,
              }}
            >
              Send this one-time setup link to{' '}
              <strong style={{ color: 'var(--text)' }}>{result.user.email}</strong>. It expires{' '}
              on{' '}
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                <FormattedDateTime value={result.expiresAt} />
              </span>
              .
            </p>
            {result.membership && attachedCompanyName ? (
              <div
                style={{
                  padding: 10,
                  background: 'var(--ok-soft)',
                  border: '1px solid color-mix(in oklch, var(--ok) 28%, transparent)',
                  borderRadius: 5,
                  fontSize: 12.5,
                  color: 'var(--text)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Icon.check size={13} style={{ color: 'var(--ok)' }} />
                <span>
                  Also added to{' '}
                  <strong>{attachedCompanyName}</strong> as{' '}
                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {membershipRoleLabel(result.membership.role)}
                  </span>
                  .
                </span>
              </div>
            ) : null}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: 10,
                background: 'var(--panel-2)',
                border: '1px solid var(--line-2)',
                borderRadius: 5,
              }}
            >
              <code
                style={{
                  flex: 1,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--text)',
                  wordBreak: 'break-all',
                }}
              >
                {result.setupUrl}
              </code>
              <Btn kind="outline" size="sm" icon={Icon.copy} onClick={copySetupLink}>
                Copy
              </Btn>
            </div>
            <Tag tone="warn">
              This link won't be shown again — copy it now.
            </Tag>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Email" htmlFor="u-email">
              <Input
                id="u-email"
                type="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value.toLowerCase())}
                placeholder="alex@example.com"
              />
            </Field>
            <Field label="Full name" htmlFor="u-name">
              <Input
                id="u-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alex Morgan"
              />
            </Field>
            <Field
              label="Global role"
              htmlFor="u-role"
              help={`${capitalize(term.one)}-specific access is granted separately via memberships.`}
              error={error ?? undefined}
            >
              <Select
                id="u-role"
                value={role}
                onChange={(e) => {
                  const next = e.target.value as UserRole;
                  setRole(next);
                  if (!lockedCompany) {
                    setAttachOpen(defaultShowMembership(next));
                  }
                  setAttachRole(DEFAULT_MEMBERSHIP_ROLES[next]);
                  if (next !== 'OPERATOR') {
                    setCapabilities([]);
                    setGlobalAccess('FULL');
                  }
                }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </Select>
            </Field>

            {role === 'OPERATOR' && (
              <OperatorAxes
                globalAccess={globalAccess}
                onGlobalAccess={setGlobalAccess}
                capabilities={capabilities}
                onCapabilities={setCapabilities}
              />
            )}

            <AttachPanel
              open={attachOpen}
              onToggle={() => !lockedCompany && setAttachOpen((v) => !v)}
              locked={lockedCompany}
              company={attachCompany}
              onCompany={setAttachCompany}
              role={attachRole}
              onRole={setAttachRole}
              expiresAt={attachExpiresAt}
              onExpiresAt={setAttachExpiresAt}
              term={term.one}
              userRole={role}
            />
          </div>
        )}
      </Dialog>
    </>
  );
}

function AttachPanel({
  open,
  onToggle,
  locked,
  company,
  onCompany,
  role,
  onRole,
  expiresAt,
  onExpiresAt,
  term,
  userRole,
}: {
  open: boolean;
  onToggle: () => void;
  locked: boolean;
  company: CompanyPickerValue | null;
  onCompany: (c: CompanyPickerValue | null) => void;
  role: MembershipRole;
  onRole: (r: MembershipRole) => void;
  expiresAt: string;
  onExpiresAt: (v: string) => void;
  term: string;
  userRole: UserRole;
}) {
  const allowedRoles = membershipRolesFor(userRole);
  const roleLocked = allowedRoles.length === 1;
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 6,
        background: open ? 'var(--panel)' : 'transparent',
      }}
    >
      <button
        type="button"
        onClick={locked ? undefined : onToggle}
        disabled={locked}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          background: 'transparent',
          border: 'none',
          cursor: locked ? 'default' : 'pointer',
          color: 'var(--text)',
          textAlign: 'left',
          fontSize: 12.5,
        }}
      >
        <Icon.chevron
          size={10}
          style={{
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms',
          }}
        />
        <span style={{ fontWeight: 500 }}>
          {locked ? `Attach to this ${term.toLowerCase()}` : `Attach to a ${term.toLowerCase()}`}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--dim)',
            marginLeft: 'auto',
          }}
        >
          {open ? (locked ? 'required' : 'optional') : 'optional'}
        </span>
      </button>
      {open && (
        <div
          style={{
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            borderTop: '1px solid var(--line)',
          }}
        >
          <Field label={term} htmlFor="u-attach-company">
            {locked && company ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--line-2)',
                  borderRadius: 5,
                  fontSize: 13,
                }}
              >
                <strong>{company.name}</strong>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--dim)',
                  }}
                >
                  /{company.slug}
                </span>
              </div>
            ) : (
              <CompanyPicker
                id="u-attach-company"
                value={company}
                onChange={onCompany}
              />
            )}
          </Field>
          <Field
            label="Membership role"
            htmlFor="u-attach-role"
            help={
              roleLocked
                ? 'Client users always join companies as read-only.'
                : undefined
            }
          >
            <Select
              id="u-attach-role"
              value={role}
              onChange={(e) => onRole(e.target.value as MembershipRole)}
              disabled={roleLocked}
            >
              {allowedRoles.map((r) => (
                <option key={r} value={r}>
                  {membershipRoleLabel(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Expires"
            htmlFor="u-attach-expires"
            help="Required for contractors. Leave blank for indefinite access."
          >
            <Input
              id="u-attach-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => onExpiresAt(e.target.value)}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function OperatorAxes({
  globalAccess,
  onGlobalAccess,
  capabilities,
  onCapabilities,
}: {
  globalAccess: GlobalAccess;
  onGlobalAccess: (g: GlobalAccess) => void;
  capabilities: PlatformCapability[];
  onCapabilities: (c: PlatformCapability[]) => void;
}) {
  const allChecked =
    capabilities.length === MANAGER_PRESET.length &&
    MANAGER_PRESET.every((c) => capabilities.includes(c));

  function toggle(c: PlatformCapability) {
    onCapabilities(
      capabilities.includes(c)
        ? capabilities.filter((x) => x !== c)
        : [...capabilities, c],
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 12,
        border: '1px solid var(--line)',
        borderRadius: 6,
        background: 'var(--panel)',
      }}
    >
      <Field
        label="Default access"
        htmlFor="u-global-access"
        help="Applied on companies this operator does not have an explicit membership for."
      >
        <Select
          id="u-global-access"
          value={globalAccess}
          onChange={(e) => onGlobalAccess(e.target.value as GlobalAccess)}
        >
          {GlobalAccessValues.map((g) => (
            <option key={g} value={g}>
              {globalAccessLabel(g)}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Platform capabilities"
        help="Granular admin tasks beyond company access. SUPER_ADMIN holds these implicitly."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12.5,
              padding: '6px 8px',
              borderRadius: 5,
              background: allChecked ? 'var(--accent-soft)' : 'transparent',
              border: '1px dashed var(--line)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(e) =>
                onCapabilities(e.target.checked ? [...MANAGER_PRESET] : [])
              }
            />
            <span style={{ fontWeight: 500 }}>Manager preset</span>
            <Tag tone="outline">{MANAGER_PRESET.length} capabilities</Tag>
          </label>
          {PlatformCapabilityValues.map((c) => (
            <label
              key={c}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12.5,
                padding: '4px 6px',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={capabilities.includes(c)}
                onChange={() => toggle(c)}
              />
              <span>{capabilityLabel(c)}</span>
            </label>
          ))}
        </div>
      </Field>
    </div>
  );
}
