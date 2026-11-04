'use client';

import { roleLabel, type UserRole } from '@weavestream/shared';

export type ChecklistUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** Shown checked and disabled (super admins: always have access). */
  alwaysIncluded: boolean;
};

/**
 * A scrollable checkbox list of internal users. Used by the per-entry
 * internal-access dialog and by the global password access policy in
 * settings; each caller owns the selection and decides what to save
 * (see `internal-access-selection.ts`).
 */
export function InternalUserChecklist<U extends ChecklistUser>({
  users,
  selectedIds,
  onToggle,
  loading = false,
  detail,
  ariaLabel,
}: {
  users: readonly U[];
  selectedIds: ReadonlySet<string>;
  onToggle: (userId: string) => void;
  loading?: boolean;
  /** Extra text after "email · role", e.g. how the user has access. */
  detail?: (user: U) => string | null;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
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
        users.map((user) => {
          const extra = detail?.(user);
          return (
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
                checked={user.alwaysIncluded || selectedIds.has(user.id)}
                disabled={user.alwaysIncluded}
                onChange={() => onToggle(user.id)}
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
                  {user.email} · {roleLabel(user.role)}
                  {extra ? ` · ${extra}` : ''}
                </span>
              </span>
            </label>
          );
        })
      )}
    </div>
  );
}
