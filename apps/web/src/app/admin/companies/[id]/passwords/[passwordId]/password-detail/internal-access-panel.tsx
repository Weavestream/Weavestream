'use client';

import { useEffect, useMemo, useState } from 'react';
import { problemMessage } from '@weavestream/shared';
import type {
  PasswordAccessMode,
  PasswordAccessUser,
  PasswordDetail,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../../../lib/api';
import { Btn, Dialog, Icon, Panel, Tag } from '../../../../../../../components/ui';
import {
  accessSourceLabel,
  accessUserIds,
  pruneUnavailable,
  restrictedIdsToSave,
  toggleSelection,
  unavailableSelection,
  withAlwaysIncluded,
} from '../../../../../../../components/passwords/internal-access-selection';
import { InternalUserChecklist } from '../../../../../../../components/passwords/internal-user-checklist';

/**
 * Copy for an entry WITHOUT its own list: it follows the global password
 * access policy (issue #110). UI text only — the API enforces the policy.
 */
const UNRESTRICTED_COPY: Record<PasswordAccessMode, { title: string; body: string; option: string }> = {
  all_users: {
    title: 'All internal users',
    body: 'Any internal user with normal company access can see this credential.',
    option: 'All internal users with company access',
  },
  selected_users: {
    title: 'Global policy (selected users)',
    body: 'Only the users in the global password access policy, and super admins, can see this credential.',
    option: 'Use the global policy (selected users)',
  },
};

export function InternalAccessPanel({
  password,
  canManage,
  currentUserId,
  passwordAccessMode,
  onEdit,
}: {
  password: PasswordDetail;
  canManage: boolean;
  currentUserId: string;
  passwordAccessMode: PasswordAccessMode;
  onEdit: () => void;
}) {
  const unrestrictedCopy = UNRESTRICTED_COPY[passwordAccessMode];
  const restrictedCount = password.restrictedToUserIds.length;
  const restricted = restrictedCount > 0;

  return (
    <Panel title="Internal access">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                fontSize: 13,
                color: 'var(--text)',
                fontWeight: 600,
              }}
            >
              {restricted ? 'Restricted' : unrestrictedCopy.title}
              {restricted && <Tag tone="warn">{restrictedCount} allowed</Tag>}
            </div>
            <p
              style={{
                margin: '4px 0 0',
                fontSize: 12.5,
                color: 'var(--muted)',
                lineHeight: 1.45,
              }}
            >
              {restricted
                ? 'Only selected internal users can see this credential.'
                : unrestrictedCopy.body}
              {restricted && password.restrictedToUserIds.includes(currentUserId) && (
                <> You&apos;re included.</>
              )}
            </p>
          </div>
          {canManage && (
            <Btn size="sm" kind="ghost" icon={Icon.edit} onClick={onEdit}>
              Edit
            </Btn>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function InternalAccessDialog({
  companyId,
  password,
  passwordAccessMode,
  onClose,
  onSaved,
}: {
  companyId: string;
  password: PasswordDetail;
  passwordAccessMode: PasswordAccessMode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [users, setUsers] = useState<PasswordAccessUser[]>([]);
  const [restricted, setRestricted] = useState(password.restrictedToUserIds.length > 0);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(password.restrictedToUserIds),
  );

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: PasswordAccessUser[] }>(
      `/companies/${companyId}/passwords/internal-access-users`,
    ).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.data) {
        setErr(problemMessage(res.problem) ?? 'Could not load internal users.');
        return;
      }
      const data = res.data;
      setUsers(data.items);
      setSelectedIds((prev) => withAlwaysIncluded(prev, data.items));
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const { selectable: selectableIds, alwaysIncluded: alwaysIncludedIds } = useMemo(
    () => accessUserIds(users),
    [users],
  );
  const unavailableIds = useMemo(
    () => unavailableSelection(selectedIds, selectableIds),
    [selectedIds, selectableIds],
  );

  const toggleUser = (userId: string) => {
    setSelectedIds((prev) => toggleSelection(prev, userId, alwaysIncludedIds));
  };

  const submit = async () => {
    setErr(null);
    const nextIds = restrictedIdsToSave(restricted, selectedIds, alwaysIncludedIds);
    if (restricted && nextIds.length === 0) {
      setErr('No always-included super admin was available for this restriction.');
      return;
    }
    setBusy(true);
    const res = await apiFetch(`/companies/${companyId}/passwords/${password.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ restrictedToUserIds: nextIds }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(problemMessage(res.problem) ?? 'Update failed');
      return;
    }
    onSaved();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Internal access"
      width={520}
      footer={
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <Btn size="sm" onClick={onClose}>
            Cancel
          </Btn>
          <Btn size="sm" kind="primary" onClick={() => void submit()} disabled={busy || loading}>
            Save
          </Btn>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={checkboxLabel}>
          <input type="radio" checked={!restricted} onChange={() => setRestricted(false)} />
          {UNRESTRICTED_COPY[passwordAccessMode].option}
        </label>
        <label style={checkboxLabel}>
          <input type="radio" checked={restricted} onChange={() => setRestricted(true)} />
          Restrict to selected internal users
        </label>

        {restricted && (
          <InternalUserChecklist
            ariaLabel="Internal users with access"
            users={users}
            selectedIds={selectedIds}
            onToggle={toggleUser}
            loading={loading}
            detail={(user) => accessSourceLabel(user.accessSource)}
          />
        )}

        {restricted && unavailableIds.length > 0 && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--warn, #b45309)',
              background: 'var(--warn-soft, rgba(245,158,11,0.12))',
              borderRadius: 6,
              padding: 8,
            }}
          >
            {unavailableIds.length} existing user
            {unavailableIds.length === 1 ? '' : 's'} can no longer be selected. Clear the
            restriction or remove unavailable users before saving.
            <div style={{ marginTop: 6 }}>
              <Btn
                size="sm"
                kind="ghost"
                onClick={() =>
                  setSelectedIds((prev) =>
                    pruneUnavailable(prev, selectableIds, alwaysIncludedIds),
                  )
                }
              >
                Remove unavailable
              </Btn>
            </div>
          </div>
        )}

        {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
      </div>
    </Dialog>
  );
}

const checkboxLabel = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 13,
  color: 'var(--text)',
} as const;
