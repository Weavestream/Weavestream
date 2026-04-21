'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MembershipRole } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  DataTable,
  Dialog,
  Field,
  Icon,
  Input,
  MobileCardRow,
  Select,
  Tag,
  UserPicker,
  useToast,
  type DataColumn,
  type UserPickerValue,
} from '../../../../components/ui';
import { roleLabel } from '../../../../lib/roles';
import { CreateUserButton } from '../../(global)/users/create-user-button';

type Row = {
  id: string;
  role: MembershipRole;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    isActive: boolean;
    mfaEnabled: boolean;
  };
};

const MEMBERSHIP_ROLES: MembershipRole[] = [
  'OPERATOR_FULL',
  'OPERATOR_READONLY',
  'CLIENT_ADMIN',
  'CLIENT_VIEWER',
];

export function CompanyMemberships({
  companyId,
  companyName,
  companySlug,
  companyArchivedAt,
  initial,
  canManage,
}: {
  companyId: string;
  companyName: string;
  companySlug: string;
  companyArchivedAt: string | null;
  initial: Row[];
  canManage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>(initial);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [revoking, setRevoking] = useState<Row | null>(null);
  const [pending, setPending] = useState(false);

  // Active member ids so the picker can filter them out of search
  // results — the server still returns them, we just don't want them
  // clickable in this dialog.
  const excludeUserIds = useMemo(
    () => rows.map((r) => r.user.id),
    [rows],
  );

  async function refresh() {
    const res = await apiFetch<Row[]>(`/companies/${companyId}/memberships`);
    if (res.ok && res.data) setRows(res.data);
    router.refresh();
  }

  async function add(input: { userId: string; role: MembershipRole; expiresAt: string | null }) {
    setPending(true);
    const res = await apiFetch(`/companies/${companyId}/memberships`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    setPending(false);
    if (!res.ok) {
      const problem = res.problem as { detail?: string } | undefined;
      toast.push(problem?.detail ?? 'Could not add member.', 'danger');
      return false;
    }
    toast.push('Member added.', 'ok');
    setAddOpen(false);
    await refresh();
    return true;
  }

  async function update(
    row: Row,
    input: { role: MembershipRole; expiresAt: string | null },
  ) {
    setPending(true);
    const res = await apiFetch(`/memberships/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    setPending(false);
    if (!res.ok) {
      toast.push('Update failed.', 'danger');
      return false;
    }
    toast.push('Membership updated.', 'ok');
    setEditing(null);
    await refresh();
    return true;
  }

  async function revoke(row: Row) {
    setPending(true);
    const res = await apiFetch(`/memberships/${row.id}`, { method: 'DELETE' });
    setPending(false);
    if (!res.ok) {
      toast.push('Revoke failed.', 'danger');
      return;
    }
    toast.push('Membership revoked.', 'ok');
    setRevoking(null);
    await refresh();
  }

  const columns: DataColumn<Row>[] = [
    {
      id: 'user',
      header: 'Member',
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{r.user.name}</span>
          <span
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--dim)' }}
          >
            {r.user.email}
          </span>
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Membership role',
      width: 170,
      render: (r) => <Tag tone="accent">{roleLabel(r.role)}</Tag>,
    },
    {
      id: 'userRole',
      header: 'Global role',
      width: 160,
      render: (r) => (
        <span style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          {roleLabel(r.user.role)}
        </span>
      ),
    },
    {
      id: 'expires',
      header: 'Expires',
      width: 150,
      mono: true,
      render: (r) =>
        r.expiresAt ? (
          <ExpirationTag date={r.expiresAt} />
        ) : (
          <span style={{ color: 'var(--dim)' }}>—</span>
        ),
    },
  ];

  if (canManage) {
    columns.push({
      id: 'actions',
      header: '',
      width: 140,
      align: 'right',
      render: (r) => (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <Btn kind="ghost" size="sm" icon={Icon.edit} onClick={() => setEditing(r)}>
            Edit
          </Btn>
          <Btn kind="ghost" size="sm" icon={Icon.trash} onClick={() => setRevoking(r)}>
            Revoke
          </Btn>
        </div>
      ),
    });
  }

  return (
    <div>
      {canManage && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 6,
            padding: 10,
            borderBottom: '1px solid var(--line)',
          }}
        >
          <CreateUserButton
            defaultCompany={{
              id: companyId,
              name: companyName,
              slug: companySlug,
              archivedAt: companyArchivedAt,
            }}
            triggerLabel="Invite new user"
            triggerKind="outline"
            triggerSize="sm"
            onCreated={() => void refresh()}
          />
          <Btn kind="primary" size="sm" icon={Icon.plus} onClick={() => setAddOpen(true)}>
            Add existing user
          </Btn>
        </div>
      )}
      <DataTable
        columns={columns}
        rows={rows}
        empty="Nobody here yet. Add your first member to give them access."
        renderMobileCard={(r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <div
                style={{ color: 'var(--text)', fontWeight: 600, fontSize: 14 }}
              >
                {r.user.name}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--dim)',
                  wordBreak: 'break-all',
                }}
              >
                {r.user.email}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Tag tone="accent">{roleLabel(r.role)}</Tag>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--muted)',
                  padding: '3px 6px',
                  border: '1px solid var(--line)',
                  borderRadius: 999,
                }}
              >
                global: {roleLabel(r.user.role)}
              </span>
            </div>
            <MobileCardRow label="Expires" mono>
              {r.expiresAt ? (
                <ExpirationTag date={r.expiresAt} />
              ) : (
                <span style={{ color: 'var(--dim)' }}>—</span>
              )}
            </MobileCardRow>
            {canManage && (
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  flexWrap: 'wrap',
                  paddingTop: 4,
                }}
              >
                <Btn
                  kind="outline"
                  size="sm"
                  icon={Icon.edit}
                  onClick={() => setEditing(r)}
                >
                  Edit
                </Btn>
                <Btn
                  kind="ghost"
                  size="sm"
                  icon={Icon.trash}
                  onClick={() => setRevoking(r)}
                >
                  Revoke
                </Btn>
              </div>
            )}
          </div>
        )}
      />

      <AddDialog
        open={addOpen}
        onClose={() => !pending && setAddOpen(false)}
        excludeUserIds={excludeUserIds}
        pending={pending}
        onSubmit={add}
      />

      <EditDialog
        row={editing}
        pending={pending}
        onClose={() => !pending && setEditing(null)}
        onSubmit={(input) => (editing ? update(editing, input) : Promise.resolve(false))}
      />

      <Dialog
        open={!!revoking}
        onClose={() => !pending && setRevoking(null)}
        title="Revoke membership?"
        footer={
          <>
            <Btn kind="ghost" onClick={() => setRevoking(null)} disabled={pending}>
              Cancel
            </Btn>
            <Btn
              kind="danger"
              loading={pending}
              onClick={() => revoking && revoke(revoking)}
            >
              Revoke access
            </Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          {revoking?.user.name} will lose access to this company immediately. They can be
          re-added later — audit history is preserved.
        </p>
      </Dialog>
    </div>
  );
}

function ExpirationTag({ date }: { date: string }) {
  const when = new Date(date);
  const ms = when.getTime() - Date.now();
  if (ms < 0) {
    return (
      <Tag tone="danger" dot>
        expired
      </Tag>
    );
  }
  const days = Math.ceil(ms / 86_400_000);
  const tone = days < 14 ? 'warn' : 'info';
  return (
    <Tag tone={tone} dot>
      in {days}d
    </Tag>
  );
}

function AddDialog({
  open,
  onClose,
  excludeUserIds,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  excludeUserIds: string[];
  pending: boolean;
  onSubmit: (input: {
    userId: string;
    role: MembershipRole;
    expiresAt: string | null;
  }) => Promise<boolean>;
}) {
  const [picked, setPicked] = useState<UserPickerValue | null>(null);
  const [role, setRole] = useState<MembershipRole>('CLIENT_VIEWER');
  const [expiresAt, setExpiresAt] = useState('');

  // Reset local state when the dialog closes so re-opening starts
  // fresh; avoids a stale selection when an operator adds multiple
  // members back-to-back.
  useEffect(() => {
    if (!open) {
      setPicked(null);
      setRole('CLIENT_VIEWER');
      setExpiresAt('');
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add member"
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            disabled={!picked}
            loading={pending}
            onClick={async () => {
              if (!picked) return;
              const ok = await onSubmit({
                userId: picked.id,
                role,
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
              });
              if (ok) {
                setPicked(null);
                setRole('CLIENT_VIEWER');
                setExpiresAt('');
              }
            }}
          >
            Add member
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field
          label="User"
          htmlFor="m-user"
          help="Type to search across every active user."
        >
          <UserPicker
            id="m-user"
            value={picked}
            onChange={setPicked}
            excludeUserIds={excludeUserIds}
            autoFocus
          />
        </Field>
        <Field label="Membership role" htmlFor="m-role">
          <Select
            id="m-role"
            value={role}
            onChange={(e) => setRole(e.target.value as MembershipRole)}
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
          htmlFor="m-expires"
          help="Required for contractors. Leave blank for indefinite access."
        >
          <Input
            id="m-expires"
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function EditDialog({
  row,
  pending,
  onClose,
  onSubmit,
}: {
  row: Row | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: {
    role: MembershipRole;
    expiresAt: string | null;
  }) => Promise<boolean>;
}) {
  const [role, setRole] = useState<MembershipRole>('CLIENT_VIEWER');
  const [expiresAt, setExpiresAt] = useState('');

  // Re-sync local draft whenever the dialog reopens on a new row. The
  // previous version kept stale local state across rows, so editing a
  // second membership would start with the first one's values filled
  // in.
  useEffect(() => {
    if (!row) return;
    setRole(row.role);
    setExpiresAt(
      row.expiresAt ? new Date(row.expiresAt).toISOString().slice(0, 16) : '',
    );
  }, [row?.id]);

  if (!row) {
    return (
      <Dialog open={false} onClose={onClose} title="Edit">
        <></>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={!!row}
      onClose={onClose}
      title={`Edit ${row.user.name}`}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            loading={pending}
            onClick={() =>
              onSubmit({
                role,
                expiresAt: expiresAt
                  ? new Date(expiresAt).toISOString()
                  : null,
              })
            }
          >
            Save
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Membership role">
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as MembershipRole)}
          >
            {MEMBERSHIP_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Expires">
          <Input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
