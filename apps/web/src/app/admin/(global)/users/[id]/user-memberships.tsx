'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GlobalAccess, MembershipRole, UserRole } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  CompanyPicker,
  DataTable,
  Dialog,
  Field,
  Icon,
  Input,
  MobileCardRow,
  Select,
  Tag,
  useToast,
  type CompanyPickerValue,
  type DataColumn,
} from '../../../../../components/ui';
import {
  globalAccessLabel,
  hasCapability,
  membershipRoleLabel,
} from '../../../../../lib/roles';
import type { Me, UserDetail } from '../../../../../lib/server-api';
import { lower } from '../../../../../lib/term';
import { useTerm } from '../../../../../lib/term-context';

type Row = UserDetail['memberships'][number];

/**
 * Membership roles the picker offers, filtered by the target user's
 * global role. RBAC v2 collapsed memberships to FULL / READONLY:
 * CLIENT_USER accounts can only hold READONLY (the API hard-rejects
 * FULL for that role), so we hide it client-side too. Every other
 * role gets both options.
 */
const ALL_MEMBERSHIP_ROLES: MembershipRole[] = ['FULL', 'READONLY'];
const CLIENT_MEMBERSHIP_ROLES: MembershipRole[] = ['READONLY'];

function rolesForUser(userRole: UserRole): MembershipRole[] {
  return userRole === 'CLIENT_USER'
    ? CLIENT_MEMBERSHIP_ROLES
    : ALL_MEMBERSHIP_ROLES;
}

function defaultRoleFor(userRole: UserRole): MembershipRole {
  if (userRole === 'CLIENT_USER') return 'READONLY';
  if (userRole === 'CONTRACTOR') return 'READONLY';
  return 'FULL';
}

export function UserMembershipsList({
  user,
  me,
  canManageUser,
}: {
  user: UserDetail;
  /**
   * Current operator; drives the "Manage" jump link visibility on each
   * row (only show it where this admin could actually edit) and the
   * "Attach to company" button gate. Matches server-side RBAC so we
   * never render a button that 403s on click.
   */
  me: Pick<Me, 'role' | 'memberships' | 'platformCapabilities'>;
  /**
   * Top-level USER_MANAGE gate from the page. The per-company
   * MEMBERSHIP_MANAGE check for each action happens inside this
   * component since it's stateful (and lets a senior operator who
   * holds USER_MANAGE see the user but not edit memberships when
   * MEMBERSHIP_MANAGE is missing).
   */
  canManageUser: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const term = useTerm();

  const [rows, setRows] = useState<Row[]>(user.memberships);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [revoking, setRevoking] = useState<Row | null>(null);
  const [pending, setPending] = useState(false);

  // Keep local state in sync if the server re-delivers the user
  // (navigation, router.refresh from a sibling action, etc.).
  useEffect(() => {
    setRows(user.memberships);
  }, [user.memberships]);

  const active = useMemo(() => rows.filter((r) => !r.revokedAt), [rows]);

  // Companies where this user already has an *active* membership get
  // hidden from the picker — we don't support two active memberships on
  // the same (user, company) pair, and the API enforces the unique
  // constraint anyway.
  const excludeCompanyIds = useMemo(
    () => active.map((r) => r.company.id),
    [active],
  );

  async function refresh() {
    const res = await apiFetch<UserDetail>(`/users/${user.id}`);
    if (res.ok && res.data) setRows(res.data.memberships);
    router.refresh();
  }

  async function add(input: {
    companyId: string;
    role: MembershipRole;
    expiresAt: string | null;
  }) {
    setPending(true);
    const res = await apiFetch(
      `/companies/${input.companyId}/memberships`,
      {
        method: 'POST',
        body: JSON.stringify({
          userId: user.id,
          role: input.role,
          expiresAt: input.expiresAt,
        }),
      },
    );
    setPending(false);
    if (!res.ok) {
      const problem = res.problem as { detail?: string } | undefined;
      toast.push(problem?.detail ?? `Could not set ${lower(term.one)}-level access.`, 'danger');
      return false;
    }
    toast.push(`${term.one}-level access set.`, 'ok');
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
      const problem = res.problem as { detail?: string } | undefined;
      toast.push(problem?.detail ?? 'Update failed.', 'danger');
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
      const problem = res.problem as { detail?: string } | undefined;
      toast.push(problem?.detail ?? 'Revoke failed.', 'danger');
      return;
    }
    toast.push('Membership revoked.', 'ok');
    setRevoking(null);
    await refresh();
  }

  const columns: DataColumn<Row>[] = [
    {
      id: 'company',
      header: term.one,
      sortValue: (r) => r.company.name.toLowerCase(),
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>
            {r.company.name}
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--dim)',
            }}
          >
            /{r.company.slug}
          </span>
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      width: 180,
      sortValue: (r) => r.role.toLowerCase(),
      render: (r) => <Tag tone="accent">{membershipRoleLabel(r.role)}</Tag>,
    },
    {
      id: 'expires',
      header: 'Expires',
      width: 160,
      mono: true,
      sortValue: (r) => (r.expiresAt ? new Date(r.expiresAt) : null),
      render: (r) => {
        if (!r.expiresAt) return <span style={{ color: 'var(--dim)' }}>never</span>;
        const ms = new Date(r.expiresAt).getTime() - Date.now();
        if (ms < 0) {
          return (
            <Tag tone="danger">
              expired
            </Tag>
          );
        }
        const days = Math.ceil(ms / 86_400_000);
        const tone = days < 14 ? 'warn' : 'info';
        return (
          <Tag tone={tone}>
            in {days}d
          </Tag>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      width: 120,
      sortValue: (r) => (r.company.archivedAt ? 1 : 0),
      render: (r) =>
        r.company.archivedAt ? (
          <Tag tone="warn">
            archived
          </Tag>
        ) : (
          <Tag tone="ok">
            active
          </Tag>
        ),
    },
  ];

  // RBAC v2: membership writes are gated by the global
  // `MEMBERSHIP_MANAGE` capability (SUPER_ADMIN holds it implicitly).
  // The per-company `Membership` no longer grants self-service
  // membership editing — that's exclusively a platform-admin concern.
  const canManageMemberships = hasCapability(me, 'MEMBERSHIP_MANAGE');

  if (canManageUser && canManageMemberships) {
    columns.push({
      id: 'actions',
      header: '',
      width: 180,
      align: 'right',
      sortable: false,
      render: (r) => {
        return (
          <div
            style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}
            onClick={(e) => e.stopPropagation()}
          >
            <Btn
              kind="ghost"
              size="sm"
              icon={Icon.edit}
              onClick={(e) => {
                e.stopPropagation();
                setEditing(r);
              }}
            >
              Edit
            </Btn>
            <Btn
              kind="ghost"
              size="sm"
              icon={Icon.trash}
              onClick={(e) => {
                e.stopPropagation();
                setRevoking(r);
              }}
            >
              Revoke
            </Btn>
          </div>
        );
      },
    });
  }

  // RBAC v2: attaching = creating a Membership row, gated by
  // MEMBERSHIP_MANAGE. Same gate as edit/revoke; per-company FULL
  // membership no longer self-grants membership writes.
  const canAttach = canManageUser && canManageMemberships;

  const orgWord = lower(term.one);

  // "No memberships" means opposite things depending on the user:
  // an operator falls back to their default (global) access, so an
  // empty list = access to ALL companies; a contractor/client without
  // memberships has access to NOTHING. Spell that out instead of the
  // ambiguous "no memberships yet".
  let emptyText: string;
  if (user.role === 'SUPER_ADMIN') {
    emptyText = `No ${orgWord} memberships — super admins have full access to every ${orgWord}.`;
  } else if (user.role === 'OPERATOR') {
    const ga = user.globalAccess ?? 'NONE';
    if (ga === 'NONE') {
      emptyText = `No ${orgWord} memberships and default access is "${globalAccessLabel('NONE')}" — this user currently has no ${orgWord} access. Add ${orgWord}-level access to grant access to a specific ${orgWord}.`;
    } else {
      emptyText = `No ${orgWord} memberships — this user has ${ga === 'FULL' ? 'full' : 'read-only'} access to every ${orgWord} via their default access. Add ${orgWord}-level access to set a different level for a specific ${orgWord}.`;
    }
  } else {
    emptyText = `This user has no ${orgWord} memberships, so they cannot access any ${orgWord}. Add ${orgWord}-level access to grant access.`;
  }

  return (
    <div>
      {canAttach && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 6,
            padding: 10,
            borderBottom: '1px solid var(--line)',
          }}
        >
          <Btn
            kind="primary"
            size="sm"
            icon={Icon.plus}
            onClick={() => setAddOpen(true)}
          >
            Set {orgWord}-level access
          </Btn>
        </div>
      )}
      <DataTable
        columns={columns}
        rows={active}
        rowHref={(r) => `/admin/companies/${r.company.id}`}
        empty={emptyText}
        renderMobileCard={(r) => {
          const canEditRow = canManageUser && canManageMemberships;
          let expiresNode: React.ReactNode = (
            <span style={{ color: 'var(--dim)' }}>never</span>
          );
          if (r.expiresAt) {
            const ms = new Date(r.expiresAt).getTime() - Date.now();
            if (ms < 0) {
              expiresNode = (
                <Tag tone="danger">
                  expired
                </Tag>
              );
            } else {
              const days = Math.ceil(ms / 86_400_000);
              const tone = days < 14 ? 'warn' : 'info';
              expiresNode = (
                <Tag tone={tone}>
                  in {days}d
                </Tag>
              );
            }
          }
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div
                  style={{
                    color: 'var(--text)',
                    fontWeight: 600,
                    fontSize: 14,
                  }}
                >
                  {r.company.name}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    color: 'var(--dim)',
                  }}
                >
                  /{r.company.slug}
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <Tag tone="accent">{membershipRoleLabel(r.role)}</Tag>
                {r.company.archivedAt ? (
                  <Tag tone="warn">
                    archived
                  </Tag>
                ) : (
                  <Tag tone="ok">
                    active
                  </Tag>
                )}
              </div>
              <MobileCardRow label="Expires" mono>
                {expiresNode}
              </MobileCardRow>
              {canEditRow && (
                <div
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
                  onClick={(e) => e.stopPropagation()}
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
          );
        }}
      />

      <AttachDialog
        open={addOpen}
        userName={user.name}
        userRole={user.role}
        userGlobalAccess={user.globalAccess}
        excludeCompanyIds={excludeCompanyIds}
        pending={pending}
        onClose={() => !pending && setAddOpen(false)}
        onSubmit={add}
      />

      <EditDialog
        row={editing}
        userRole={user.role}
        pending={pending}
        onClose={() => !pending && setEditing(null)}
        onSubmit={(input) =>
          editing ? update(editing, input) : Promise.resolve(false)
        }
      />

      <Dialog
        open={!!revoking}
        onClose={() => !pending && setRevoking(null)}
        title="Revoke membership?"
        footer={
          <>
            <Btn
              kind="ghost"
              onClick={() => setRevoking(null)}
              disabled={pending}
            >
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
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: 'var(--text-2)',
            lineHeight: 1.5,
          }}
        >
          {user.role === 'OPERATOR' &&
          user.globalAccess &&
          user.globalAccess !== 'NONE' ? (
            <>
              {user.name}&apos;s access to{' '}
              <strong>{revoking?.company.name}</strong> will revert to their
              default access ({globalAccessLabel(user.globalAccess)})
              immediately.
            </>
          ) : (
            <>
              {user.name} will lose access to{' '}
              <strong>{revoking?.company.name}</strong> immediately.
            </>
          )}{' '}
          {term.one}-level access can be set again later — audit history is
          preserved.
        </p>
      </Dialog>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Dialogs
// ───────────────────────────────────────────────────────────────────

function AttachDialog({
  open,
  userName,
  userRole,
  userGlobalAccess,
  excludeCompanyIds,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  userName: string;
  userRole: UserRole;
  userGlobalAccess: GlobalAccess | null;
  excludeCompanyIds: string[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: {
    companyId: string;
    role: MembershipRole;
    expiresAt: string | null;
  }) => Promise<boolean>;
}) {
  const term = useTerm();
  const [picked, setPicked] = useState<CompanyPickerValue | null>(null);
  const [role, setRole] = useState<MembershipRole>(defaultRoleFor(userRole));
  const [expiresAt, setExpiresAt] = useState('');

  const availableRoles = useMemo(() => rolesForUser(userRole), [userRole]);

  useEffect(() => {
    if (!open) {
      setPicked(null);
      setRole(defaultRoleFor(userRole));
      setExpiresAt('');
    }
  }, [open, userRole]);

  // Contractors should always have a time-boxed membership per the
  // Part-0 threat model; surface the requirement as soft validation
  // (the API is still the source of truth).
  const contractorWarning =
    userRole === 'CONTRACTOR' && !expiresAt
      ? 'Contractors should have a membership expiry date.'
      : null;

  // For an operator with default access, a membership *overrides* it
  // for one company (and their default comes back when it expires or
  // is revoked); for everyone else it *grants* access they otherwise
  // lack. Spell out which one applies.
  const roleHelp =
    userRole === 'OPERATOR' && userGlobalAccess && userGlobalAccess !== 'NONE'
      ? `Overrides this user's default access (${globalAccessLabel(userGlobalAccess)}) for this ${lower(term.one)} only. Their default access returns if this expires or is revoked.`
      : `Grants access to this ${lower(term.one)} only.`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Set ${lower(term.one)}-level access for ${userName}`}
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
              await onSubmit({
                companyId: picked.id,
                role,
                expiresAt: expiresAt
                  ? new Date(expiresAt).toISOString()
                  : null,
              });
            }}
          >
            Set access
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field
          label={term.one}
          htmlFor="u-attach-company"
          help={`Type to search. ${term.one}s where this user is already a member are hidden.`}
        >
          <CompanyPicker
            id="u-attach-company"
            value={picked}
            onChange={setPicked}
            excludeCompanyIds={excludeCompanyIds}
            autoFocus
          />
        </Field>
        <Field label="Access level" htmlFor="u-attach-role" help={roleHelp}>
          <Select
            id="u-attach-role"
            value={role}
            onChange={(e) => setRole(e.target.value as MembershipRole)}
          >
            {availableRoles.map((r) => (
              <option key={r} value={r}>
                {membershipRoleLabel(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Expires"
          htmlFor="u-attach-expires"
          help={
            contractorWarning ??
            'Leave blank for indefinite access. Required for contractors.'
          }
        >
          <Input
            id="u-attach-expires"
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
  userRole,
  pending,
  onClose,
  onSubmit,
}: {
  row: Row | null;
  userRole: UserRole;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: {
    role: MembershipRole;
    expiresAt: string | null;
  }) => Promise<boolean>;
}) {
  const [role, setRole] = useState<MembershipRole>(defaultRoleFor(userRole));
  const [expiresAt, setExpiresAt] = useState('');

  const availableRoles = useMemo(() => rolesForUser(userRole), [userRole]);

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
      title={`Edit ${row.company.name}`}
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
            {availableRoles.map((r) => (
              <option key={r} value={r}>
                {membershipRoleLabel(r)}
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
