'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  GlobalAccess,
  PlatformCapability,
  UserRole,
} from '@weavestream/shared';
import { MANAGER_PRESET, PlatformCapabilityValues } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  Dialog,
  Field,
  Icon,
  Input,
  Select,
  Tag,
  useToast,
} from '../../../../../components/ui';
import {
  capabilityLabel,
  globalAccessLabel,
  roleLabel,
} from '../../../../../lib/roles';
import type { UserDetail } from '../../../../../lib/server-api';

const ROLES: UserRole[] = [
  'SUPER_ADMIN',
  'OPERATOR',
  'CONTRACTOR',
  'CLIENT_USER',
];

const GLOBAL_ACCESS_OPTIONS: GlobalAccess[] = ['FULL', 'READONLY', 'NONE'];

type InviteResponse = { setupUrl: string; expiresAt: string };

export function UserActions({ user, isSelf }: { user: UserDetail; isSelf: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState<InviteResponse | null>(null);
  const [pending, setPending] = useState(false);

  async function toggleActive() {
    setPending(true);
    const res = await apiFetch(`/users/${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !user.isActive }),
    });
    setPending(false);
    if (!res.ok) {
      toast.push('Operation failed.', 'danger');
      return;
    }
    toast.push(user.isActive ? 'User deactivated.' : 'User reactivated.', 'ok');
    setDeactivateOpen(false);
    router.refresh();
  }

  async function resetMfa() {
    setPending(true);
    const res = await apiFetch(`/users/${user.id}/reset-mfa`, { method: 'POST' });
    setPending(false);
    if (!res.ok) {
      toast.push('Reset failed.', 'danger');
      return;
    }
    toast.push('MFA reset. User will re-enrol on next login.', 'ok');
    setResetOpen(false);
    router.refresh();
  }

  async function reissueInvite() {
    setPending(true);
    const res = await apiFetch<InviteResponse>(`/users/${user.id}/invite`, {
      method: 'POST',
    });
    setPending(false);
    if (!res.ok || !res.data) {
      toast.push('Could not generate setup link.', 'danger');
      return;
    }
    setInvite(res.data);
    setInviteOpen(true);
  }

  return (
    <>
      <Btn kind="outline" size="md" icon={Icon.edit} onClick={() => setEditOpen(true)}>
        Edit
      </Btn>
      <Btn
        kind="outline"
        size="md"
        icon={Icon.key}
        onClick={reissueInvite}
        loading={pending && !inviteOpen}
        disabled={!user.isActive}
      >
        Send setup link
      </Btn>
      <Btn kind="outline" size="md" icon={Icon.shield} onClick={() => setResetOpen(true)}>
        Reset MFA
      </Btn>
      <Btn
        kind={user.isActive ? 'outline' : 'solid'}
        size="md"
        icon={user.isActive ? Icon.archive : Icon.check}
        onClick={() => setDeactivateOpen(true)}
        disabled={isSelf && user.isActive}
      >
        {user.isActive ? 'Deactivate' : 'Reactivate'}
      </Btn>

      <EditDialog
        user={user}
        open={editOpen}
        isSelf={isSelf}
        onClose={() => setEditOpen(false)}
        onSuccess={() => {
          setEditOpen(false);
          router.refresh();
        }}
      />

      <Dialog
        open={resetOpen}
        onClose={() => !pending && setResetOpen(false)}
        title="Reset two-factor?"
        footer={
          <>
            <Btn kind="ghost" onClick={() => setResetOpen(false)} disabled={pending}>
              Cancel
            </Btn>
            <Btn kind="danger" loading={pending} onClick={resetMfa}>
              Reset MFA
            </Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Every active session for {user.name} will be revoked. They'll enrol a new
          authenticator on their next sign-in.
        </p>
      </Dialog>

      <Dialog
        open={deactivateOpen}
        onClose={() => !pending && setDeactivateOpen(false)}
        title={user.isActive ? 'Deactivate user?' : 'Reactivate user?'}
        footer={
          <>
            <Btn kind="ghost" onClick={() => setDeactivateOpen(false)} disabled={pending}>
              Cancel
            </Btn>
            <Btn
              kind={user.isActive ? 'danger' : 'primary'}
              loading={pending}
              onClick={toggleActive}
            >
              {user.isActive ? 'Deactivate' : 'Reactivate'}
            </Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          {user.isActive
            ? `${user.name} will be signed out of every device. Memberships are preserved and access is restored if you reactivate them later.`
            : `${user.name} will regain the ability to sign in. Any existing memberships stay intact.`}
        </p>
      </Dialog>

      <Dialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="New setup link"
        width={480}
        footer={
          <Btn kind="primary" onClick={() => setInviteOpen(false)}>
            Done
          </Btn>
        }
      >
        {invite && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: 'var(--text-2)',
                lineHeight: 1.5,
              }}
            >
              Send this to {user.email}. It expires{' '}
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                {new Date(invite.expiresAt).toLocaleString()}
              </span>
              .
            </p>
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
                {invite.setupUrl}
              </code>
              <Btn
                kind="outline"
                size="sm"
                icon={Icon.copy}
                onClick={() => {
                  navigator.clipboard
                    .writeText(invite.setupUrl)
                    .then(() => toast.push('Copied.', 'ok'))
                    .catch(() => toast.push('Copy failed.', 'danger'));
                }}
              >
                Copy
              </Btn>
            </div>
            <Tag tone="warn">Shown once — copy it now.</Tag>
          </div>
        )}
      </Dialog>
    </>
  );
}

function EditDialog({
  user,
  isSelf,
  open,
  onClose,
  onSuccess,
}: {
  user: UserDetail;
  isSelf: boolean;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<UserRole>(user.role);
  const [globalAccess, setGlobalAccess] = useState<GlobalAccess>(
    user.globalAccess ?? 'FULL',
  );
  const [capabilities, setCapabilities] = useState<PlatformCapability[]>(
    user.platformCapabilities,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Reset state whenever the dialog re-opens for a different snapshot.
  useEffect(() => {
    if (!open) return;
    setName(user.name);
    setRole(user.role);
    setGlobalAccess(user.globalAccess ?? 'FULL');
    setCapabilities(user.platformCapabilities);
    setError(null);
  }, [open, user.id, user.name, user.role, user.globalAccess, user.platformCapabilities]);

  const showOperatorAxes = role === 'OPERATOR';
  const allChecked = useMemo(
    () =>
      MANAGER_PRESET.every((c) => capabilities.includes(c)) &&
      capabilities.length === MANAGER_PRESET.length,
    [capabilities],
  );

  function toggleCapability(c: PlatformCapability) {
    setCapabilities((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  }

  async function submit() {
    setError(null);
    setPending(true);
    const body: Record<string, unknown> = { name, role };
    if (showOperatorAxes) {
      body.globalAccess = globalAccess;
      body.platformCapabilities = capabilities;
    } else if (user.role === 'OPERATOR') {
      // Demoting away from OPERATOR — explicitly clear so the API
      // doesn't reject "leftover" axes from the previous role. The
      // service also wipes them server-side, but sending an empty
      // capability list keeps the request body self-explanatory.
      body.platformCapabilities = [];
    }
    const res = await apiFetch(`/users/${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    setPending(false);
    if (!res.ok) {
      const p = res.problem as { detail?: string; title?: string } | undefined;
      setError(p?.detail ?? p?.title ?? 'Update failed.');
      return;
    }
    toast.push('User updated.', 'ok');
    onSuccess();
  }

  return (
    <Dialog
      open={open}
      onClose={() => !pending && onClose()}
      title="Edit user"
      width={520}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Btn>
          <Btn kind="primary" onClick={submit} loading={pending}>
            Save
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Full name" htmlFor="e-name">
          <Input id="e-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Global role"
          htmlFor="e-role"
          help={isSelf ? 'You cannot change your own role.' : undefined}
          error={error ?? undefined}
        >
          <Select
            id="e-role"
            value={role}
            disabled={isSelf}
            onChange={(e) => setRole(e.target.value as UserRole)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        </Field>
        {showOperatorAxes && (
          <>
            <Field
              label="Default access"
              htmlFor="e-global-access"
              help="Applied on every company this user does not have an explicit membership for. NONE means access is membership-only."
            >
              <Select
                id="e-global-access"
                value={globalAccess}
                onChange={(e) => setGlobalAccess(e.target.value as GlobalAccess)}
              >
                {GLOBAL_ACCESS_OPTIONS.map((g) => (
                  <option key={g} value={g}>
                    {globalAccessLabel(g)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Platform capabilities"
              help="Granular admin tasks an operator can perform. SUPER_ADMIN holds these implicitly; here you delegate them to senior operators."
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12.5,
                    color: 'var(--text)',
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
                      setCapabilities(e.target.checked ? [...MANAGER_PRESET] : [])
                    }
                  />
                  <span style={{ fontWeight: 500 }}>Manager preset</span>
                  <Tag tone="outline">
                    {MANAGER_PRESET.length} capabilities
                  </Tag>
                </label>
                {PlatformCapabilityValues.map((c) => (
                  <label
                    key={c}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12.5,
                      color: 'var(--text)',
                      padding: '4px 6px',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={capabilities.includes(c)}
                      onChange={() => toggleCapability(c)}
                    />
                    <span>{capabilityLabel(c)}</span>
                  </label>
                ))}
              </div>
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}
