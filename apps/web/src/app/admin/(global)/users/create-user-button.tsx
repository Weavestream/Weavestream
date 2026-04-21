'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MembershipRole, UserRole } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
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
import { roleLabel } from '../../../../lib/roles';
import { capitalize } from '../../../../lib/term';
import { useTerm } from '../../../../lib/term-context';

const ROLES: UserRole[] = [
  'SUPER_ADMIN',
  'OPERATOR',
  'CONTRACTOR',
  'CLIENT_USER',
];

const MEMBERSHIP_ROLES: MembershipRole[] = [
  'OPERATOR_FULL',
  'OPERATOR_READONLY',
  'CLIENT_ADMIN',
  'CLIENT_VIEWER',
];

/**
 * Global roles that are meant to *need* a company assignment to do
 * anything useful. SUPER_ADMIN has global access and OPERATOR gets its
 * per-company role via explicit membership, so those don't auto-show
 * the attach panel — the operator creating them can still expand it
 * manually via the toggle.
 */
const DEFAULT_MEMBERSHIP_ROLES: Record<UserRole, MembershipRole> = {
  SUPER_ADMIN: 'OPERATOR_FULL',
  OPERATOR: 'OPERATOR_FULL',
  CONTRACTOR: 'CLIENT_VIEWER',
  CLIENT_USER: 'CLIENT_VIEWER',
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
  const [attachRole, setAttachRole] = useState<MembershipRole>('CLIENT_VIEWER');
  const [attachExpiresAt, setAttachExpiresAt] = useState('');

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
      setAttachRole('CLIENT_VIEWER');
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
    setAttachRole('CLIENT_VIEWER');
    setAttachExpiresAt('');
  }

  async function submit() {
    setError(null);
    setPending(true);
    const body: Record<string, unknown> = { email, name, role };
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
                {new Date(result.expiresAt).toLocaleString()}
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
                    {roleLabel(result.membership.role)}
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
                }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </Select>
            </Field>

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
}) {
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
          <Field label="Membership role" htmlFor="u-attach-role">
            <Select
              id="u-attach-role"
              value={role}
              onChange={(e) => onRole(e.target.value as MembershipRole)}
            >
              {MEMBERSHIP_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
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
