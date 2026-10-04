'use client';

import { useEffect, useMemo, useState } from 'react';
import { problemMessage, roleLabel } from '@weavestream/shared';
import type { PasswordAccessUser, PasswordDetail } from '@weavestream/shared';
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
} from './internal-access-selection';

export function InternalAccessPanel({
  password,
  canManage,
  currentUserId,
  onEdit,
}: {
  password: PasswordDetail;
  canManage: boolean;
  currentUserId: string;
  onEdit: () => void;
}) {
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
              {restricted ? 'Restricted' : 'All internal users'}
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
                : 'Any internal user with normal company access can see this credential.'}
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
  onClose,
  onSaved,
}: {
  companyId: string;
  password: PasswordDetail;
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
          All internal users with company access
        </label>
        <label style={checkboxLabel}>
          <input type="radio" checked={restricted} onChange={() => setRestricted(true)} />
          Restrict to selected internal users
        </label>

        {restricted && (
          <div
            style={{
              border: '1px solid var(--line)',
              borderRadius: 6,
              maxHeight: 260,
              overflow: 'auto',
            }}
          >
            {loading ? (
              <div style={{ padding: 12, fontSize: 13, color: 'var(--muted)' }}>
                Loading internal users...
              </div>
            ) : users.length === 0 ? (
              <div style={{ padding: 12, fontSize: 13, color: 'var(--muted)' }}>
                No eligible internal users found.
              </div>
            ) : (
              users.map((user) => (
                <label
                  key={user.id}
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'flex-start',
                    padding: '9px 12px',
                    borderBottom: '1px solid var(--line)',
                    cursor: user.alwaysIncluded ? 'default' : 'pointer',
                    opacity: user.alwaysIncluded ? 0.78 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(user.id)}
                    disabled={user.alwaysIncluded}
                    onChange={() => toggleUser(user.id)}
                    style={{ marginTop: 2 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 13,
                        color: 'var(--text)',
                        fontWeight: 600,
                      }}
                    >
                      {user.name}
                      {user.alwaysIncluded && (
                        <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
                          {' '}
                          (always included)
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 12,
                        color: 'var(--muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {user.email} · {roleLabel(user.role)} · {accessSourceLabel(user.accessSource)}
                    </span>
                  </span>
                </label>
              ))
            )}
          </div>
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
