'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  PASSWORD_ACCESS_MODE_LABELS,
  problemMessage,
  type PasswordAccessMode,
  type PasswordAccessPolicy,
} from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { Btn, Icon, RadioOption, Tag, useToast } from '../../../../components/ui';
import {
  accessUserIds,
  globalPolicyIdsToSave,
  pruneUnavailable,
  unavailableSelection,
} from '../../../../components/passwords/internal-access-selection';
import { PasswordAccessUsersDialog } from './password-access-users-dialog';
import { SectionHeader } from './settings-form';

const MODE_HELP: Record<PasswordAccessMode, string> = {
  all_users:
    'Every internal user with access to a company can open its password entries. This is the default.',
  selected_users:
    'Only the users you select, and super admins, can open password entries. Users without access do not see the entries in lists, search, or MCP.',
};

const SAVE_FAILED = 'Could not change the password access policy.';

/**
 * Global password access policy (issue #110). It decides who can open a
 * password entry that has no own internal-access list; an entry with its own
 * list ignores it. Saved through its own step-up route (`apiFetch` asks for
 * step-up). Super admins show as checked but are never sent: they always
 * have access, and the API rejects their ids.
 *
 * The API also rejects ids of users who are no longer eligible (deactivated
 * or now a client user), and they are not in the checkbox list. In
 * "Selected users" the admin removes them before saving, the same as the
 * entry dialog. In "All users" the list is hidden, so the save drops them.
 */
export function PasswordAccessPolicySection({ initial }: { initial: PasswordAccessPolicy | null }) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<PasswordAccessMode>(initial?.mode ?? 'all_users');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(initial?.userIds ?? []),
  );
  const [saved, setSaved] = useState(() => ({
    mode: initial?.mode ?? 'all_users',
    userIds: [...(initial?.userIds ?? [])].sort(),
  }));
  const [pending, setPending] = useState(false);
  const [managing, setManaging] = useState(false);

  const users = useMemo(() => initial?.users ?? [], [initial]);
  const { selectable, alwaysIncluded } = useMemo(() => accessUserIds(users), [users]);
  const userIds = globalPolicyIdsToSave(selectedIds, alwaysIncluded);
  const unavailableIds = useMemo(
    () => unavailableSelection(selectedIds, selectable),
    [selectedIds, selectable],
  );
  const blockedByUnavailable = mode === 'selected_users' && unavailableIds.length > 0;
  const dirty =
    mode !== saved.mode ||
    (mode === 'selected_users' && userIds.join(',') !== saved.userIds.join(','));
  // Active selected users, for the summary. Unavailable ids are not in
  // `users`, so they drop out here and get their own warning below.
  const selectedUsers = users.filter((u) => !u.alwaysIncluded && selectedIds.has(u.id));

  if (!initial) {
    return (
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SectionHeader label="Password access" help="Who can open password entries." />
        <Tag tone="danger">Could not load the password access policy.</Tag>
      </section>
    );
  }

  async function save() {
    if (pending || !dirty || blockedByUnavailable) return;
    setPending(true);
    // `all_users` keeps the list as it is, so switching back later restores it.
    // Unavailable ids and users promoted to super admin since are dropped
    // from it, or the API rejects the save.
    const body = {
      mode,
      userIds:
        mode === 'selected_users'
          ? userIds
          : globalPolicyIdsToSave(
              new Set(saved.userIds.filter((id) => selectable.has(id))),
              alwaysIncluded,
            ),
    };
    let res: Awaited<ReturnType<typeof apiFetch>>;
    try {
      res = await apiFetch('/settings/password-access-policy', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    } catch {
      toast.push(`${SAVE_FAILED} Weavestream could not be reached; reload to see the current state.`, 'danger');
      return;
    } finally {
      setPending(false);
    }
    if (!res.ok) {
      if (!res.stepUpCancelled) toast.push(problemMessage(res.problem) ?? SAVE_FAILED, 'danger');
      return;
    }
    setSaved({ mode: body.mode, userIds: [...body.userIds] });
    toast.push('Password access policy saved.', 'ok');
    router.refresh();
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeader
        label="Password access"
        help="Who can open password entries that have no own internal-access list. An entry with its own list uses only that list."
      />
      <fieldset
        aria-label="Password access"
        style={{
          margin: 0,
          padding: 0,
          border: 0,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          opacity: pending ? 0.6 : 1,
          pointerEvents: pending ? 'none' : undefined,
        }}
      >
        {(['all_users', 'selected_users'] as const).map((m) => (
          <RadioOption
            key={m}
            name="password-access-mode"
            checked={mode === m}
            onChange={() => setMode(m)}
            label={PASSWORD_ACCESS_MODE_LABELS[m]}
            hint={MODE_HELP[m]}
          />
        ))}
      </fieldset>

      {mode === 'selected_users' && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
              border: '1px solid var(--line)',
              borderRadius: 6,
              padding: '10px 12px',
            }}
          >
            <div style={{ minWidth: 0, flex: '1 1 240px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                {selectedUsers.length} selected user{selectedUsers.length === 1 ? '' : 's'}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {selectedUserPreview(selectedUsers.map((u) => u.name))}
                {alwaysIncluded.size > 0 && ' · Super admins always have access.'}
              </div>
            </div>
            <Btn size="sm" icon={Icon.users} onClick={() => setManaging(true)} disabled={pending}>
              Manage users
            </Btn>
          </div>
          {unavailableIds.length > 0 && (
            <Tag tone="warn">
              {unavailableIds.length} selected user{unavailableIds.length === 1 ? ' is' : 's are'} no
              longer active internal users. Remove them before saving.
            </Tag>
          )}
          {unavailableIds.length > 0 && (
            <div>
              <Btn
                size="sm"
                kind="ghost"
                onClick={() =>
                  setSelectedIds((prev) => pruneUnavailable(prev, selectable, alwaysIncluded))
                }
              >
                Remove unavailable
              </Btn>
            </div>
          )}
          {userIds.length === unavailableIds.length && (
            <Tag tone="warn">Only super admins can open entries that use the global policy.</Tag>
          )}
        </>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Btn kind="primary" onClick={() => void save()} disabled={!dirty || pending || blockedByUnavailable}>
          Save password access
        </Btn>
        {dirty && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Unsaved changes</span>}
      </div>

      {managing && (
        <PasswordAccessUsersDialog
          users={users}
          selectedIds={selectedIds}
          alwaysIncluded={alwaysIncluded}
          onClose={() => setManaging(false)}
          onApply={(next) => {
            setSelectedIds(next);
            setManaging(false);
          }}
        />
      )}
    </section>
  );
}

/** "Ana, Ben, Cy and 4 more", or a prompt when nobody is selected. */
function selectedUserPreview(names: readonly string[]): string {
  if (names.length === 0) return 'No users selected.';
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}
