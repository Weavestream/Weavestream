'use client';

import { useMemo, useState } from 'react';
import type { PasswordAccessPolicy } from '@weavestream/shared';
import { Btn, Dialog, Icon, Input } from '../../../../components/ui';
import { toggleSelection } from '../../../../components/passwords/internal-access-selection';
import { InternalUserChecklist } from '../../../../components/passwords/internal-user-checklist';

type PolicyUser = PasswordAccessPolicy['users'][number];

/**
 * Picks the users in the global password access policy. It edits a draft
 * copy of the selection: "Apply" hands it back to the settings section,
 * which still saves it. Cancel or Escape drops the draft.
 *
 * The search filters the loaded list on the client. The list is every
 * eligible internal user, so it is bounded by the size of the MSP's team.
 */
export function PasswordAccessUsersDialog({
  users,
  selectedIds,
  alwaysIncluded,
  onApply,
  onClose,
}: {
  users: readonly PolicyUser[];
  selectedIds: ReadonlySet<string>;
  alwaysIncluded: ReadonlySet<string>;
  onApply: (next: ReadonlySet<string>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ReadonlySet<string>>(selectedIds);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    );
  }, [users, query]);

  const selectedCount = users.filter((u) => !u.alwaysIncluded && draft.has(u.id)).length;
  const adminCount = alwaysIncluded.size;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Users with password access"
      width={560}
      footer={
        <>
          <Btn size="sm" onClick={onClose}>
            Cancel
          </Btn>
          <Btn size="sm" kind="primary" onClick={() => onApply(draft)}>
            Apply
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--dim)',
              display: 'flex',
            }}
          >
            <Icon.search size={12} />
          </span>
          <Input
            type="search"
            aria-label="Search users"
            placeholder="Search by name or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            style={{ paddingLeft: 30 }}
          />
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {selectedCount} selected
          {adminCount > 0 &&
            ` · ${adminCount} super admin${adminCount === 1 ? '' : 's'} always included`}
        </div>
        <InternalUserChecklist
          ariaLabel="Users with password access"
          users={shown}
          selectedIds={draft}
          onToggle={(id) => setDraft((prev) => toggleSelection(prev, id, alwaysIncluded))}
          emptyMessage={
            users.length === 0 ? undefined : 'No users match your search.'
          }
          maxHeight="min(420px, calc(100dvh - 300px))"
        />
      </div>
    </Dialog>
  );
}
