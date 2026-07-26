'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { PasswordGeneratorDefaults } from '@weavestream/shared';
import type {
  PasswordDetail,
  PasswordAccessUser,
  PasswordFolderRow,
  PasswordVersionRow,
} from '../../../../../../lib/server-api';
import { apiFetch } from '../../../../../../lib/api';
import { copyToClipboard } from '@weavestream/shared/browser';
import {
  FormattedCalendarDate,
  FormattedDate,
  FormattedDateTime,
  FormattedShortDateTime,
} from '../../../../../../lib/timezone-context';
import {
  Btn,
  Dialog,
  Field,
  Icon,
  Input,
  Panel,
  Select,
  StarButton,
  Tag,
  Textarea,
  useToast,
} from '../../../../../../components/ui';
import { PasswordRevealField } from '../../../../../../components/passwords/password-reveal-field';
import { TotpCode } from '../../../../../../components/passwords/totp-code';
import { PasswordStrengthMeter } from '../../../../../../components/passwords/password-strength-meter';
import { SecretInput } from '../../../../../../components/passwords/secret-input';
import {
  PasswordAdvancedDisclosure,
  PasswordFieldGrid,
  PasswordFormSection,
  PasswordGhostAction,
  PasswordSettingChoice,
  PasswordTotpCard,
} from '../../../../../../components/passwords/password-form-layout';
import {
  TagsInput,
  toPlainNameList,
  type TagChipDraft,
} from '../../../../../../components/tags/tags-input';
import { LinkedItemsPanel } from '../../../../../../components/relations';
import { AttachmentsPanel } from '../../../../../../components/upload/attachments-panel';
import {
  buildPasswordFolderOptions,
  formatFolderOptionLabel,
} from '../../../../../../lib/password-folder-tree';

interface Props {
  companyId: string;
  password: PasswordDetail;
  versions: PasswordVersionRow[];
  canManage: boolean;
  canManageInternalAccess: boolean;
  folderName: string | null;
  assetName: string | null;
  me: { id: string; role: string };
}

export function PasswordHeaderActions({
  companyId,
  password,
  folders,
  canManage,
  generatorDefaults,
}: {
  companyId: string;
  password: PasswordDetail;
  folders: PasswordFolderRow[];
  canManage: boolean;
  generatorDefaults: PasswordGeneratorDefaults;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);

  async function archive() {
    const res = await apiFetch(
      `/companies/${companyId}/passwords/${password.id}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      toast.push(
        (res.problem as { message?: string } | undefined)?.message ??
          'Archive failed',
        'danger',
      );
      return;
    }
    toast.push('Password archived', 'ok');
    startTransition(() => router.refresh());
  }

  async function restore() {
    const res = await apiFetch(
      `/companies/${companyId}/passwords/${password.id}/restore`,
      { method: 'POST' },
    );
    if (!res.ok) {
      toast.push(
        (res.problem as { message?: string } | undefined)?.message ??
          'Restore failed',
        'danger',
      );
      return;
    }
    toast.push('Password restored', 'ok');
    startTransition(() => router.refresh());
  }

  return (
    <>
      <StarButton
        entityType="password"
        entityId={password.id}
        initialStarred={password.isStarred}
        showLabel
        iconSize={14}
      />
      {canManage && (
        <>
          <Btn
            kind="outline"
            size="md"
            icon={Icon.edit}
            onClick={() => setEditing(true)}
          >
            Edit
          </Btn>
          {password.archivedAt ? (
            <Btn
              kind="solid"
              size="md"
              icon={Icon.check}
              onClick={() => void restore()}
            >
              Restore
            </Btn>
          ) : (
            <Btn
              kind="outline"
              size="md"
              icon={Icon.archive}
              onClick={() => void archive()}
            >
              Archive
            </Btn>
          )}
        </>
      )}

      {editing && (
        <EditPasswordDialog
          companyId={companyId}
          password={password}
          folders={folders}
          generatorDefaults={generatorDefaults}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast.push('Password updated', 'ok');
            startTransition(() => router.refresh());
          }}
        />
      )}
    </>
  );
}

/**
 * Phase 10 — password detail client shell.
 *
 * Renders the read-only summary panels + a reveal field + live TOTP
 * code + sidebar metadata. Header actions live in PasswordHeaderActions
 * so the page header can follow the same icon/title/actions layout as
 * other detail pages.
 */
export function PasswordDetailClient({
  companyId,
  password,
  versions,
  canManage,
  canManageInternalAccess,
  folderName,
  assetName,
  me,
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [editingInternalAccess, setEditingInternalAccess] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [versionsExpanded, setVersionsExpanded] = useState(false);

  async function copyUsername() {
    if (!password.username) return;
    const ok = await copyToClipboard(password.username);
    toast.push(ok ? 'Username copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  async function copyUrl() {
    if (!password.url) return;
    const ok = await copyToClipboard(password.url);
    toast.push(ok ? 'URL copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  const notesHtml = useMemo(
    () => renderNotes(password.notes ?? null),
    [password.notes],
  );
  const displayUrl = useMemo(
    () => formatCredentialUrl(password.url),
    [password.url],
  );

  return (
    <>
      <div
        className="detail-grid-main-aside"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 320px',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Panel title="Credentials">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '120px 1fr',
                rowGap: 12,
                columnGap: 16,
                fontSize: 13,
              }}
            >
              <Label>Username</Label>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minWidth: 0,
                }}
              >
                <code
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    color: 'var(--text)',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {password.username ?? '—'}
                </code>
                {password.username && (
                  <Btn
                    size="sm"
                    onClick={() => void copyUsername()}
                    title="Copy"
                    style={{ marginLeft: 'auto', flexShrink: 0 }}
                  >
                    <Icon.copy size={14} />
                  </Btn>
                )}
              </div>

              <Label>Password</Label>
              <div>
                <PasswordRevealField
                  companyId={companyId}
                  passwordId={password.id}
                  requiresReason={password.requireReasonToView}
                  // `updatedAt` rolls forward on every server-side
                  // mutation (edit, restore-from-version, etc). Using
                  // it as the reset key guarantees any cached plaintext
                  // in the client component is flushed after a restore
                  // so the next reveal fetches the newly-active value.
                  resetKey={password.updatedAt}
                />
              </div>

              <Label>Strength</Label>
              <div>
                <PasswordStrengthMeter
                  score={password.passwordStrength}
                  width={220}
                  inline
                />
              </div>

              {password.hasTotp && (
                <>
                  <Label>TOTP</Label>
                  <div>
                    <TotpCode
                      companyId={companyId}
                      passwordId={password.id}
                      resetKey={password.updatedAt}
                    />
                  </div>
                </>
              )}

              <Label>URL</Label>
              <div style={{ minWidth: 0 }}>
                {password.url ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      minWidth: 0,
                    }}
                  >
                    <a
                      href={password.url}
                      target="_blank"
                      rel="noreferrer"
                      title={password.url}
                      style={{
                        color: 'var(--accent)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      {displayUrl}
                    </a>
                    <Btn
                      size="sm"
                      onClick={() => void copyUrl()}
                      title="Copy URL"
                      style={{ marginLeft: 'auto', flexShrink: 0 }}
                    >
                      <Icon.copy size={14} />
                    </Btn>
                  </div>
                ) : (
                  <span style={{ color: 'var(--muted)' }}>—</span>
                )}
              </div>
            </div>
          </Panel>

          <Panel title="Notes">
            {notesHtml ? (
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--text)',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.5,
                }}
              >
                {notesHtml}
              </div>
            ) : (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                No notes.
              </div>
            )}
          </Panel>

        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <LinkedItemsPanel
            companyId={companyId}
            entityType="password"
            entityId={password.id}
            editable={canManage && !password.archivedAt}
          />

          <AttachmentsPanel
            companyId={companyId}
            entityType="password"
            entityId={password.id}
            editable={canManage && !password.archivedAt}
          />

          <Panel
            title="Details"
            actions={
              <button
                type="button"
                onClick={() => setDetailsExpanded((v) => !v)}
                style={{
                  border: 0,
                  background: 'transparent',
                  color: 'var(--accent)',
                  fontSize: 11,
                  cursor: 'pointer',
                  padding: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                {detailsExpanded ? 'Show less' : 'Show more'}
              </button>
            }
          >
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: '100px 1fr',
                rowGap: 8,
                columnGap: 10,
                fontSize: 12.5,
                margin: 0,
              }}
            >
              {password.assetId && (
                <>
                  <dt style={dt}>Asset</dt>
                  <dd style={dd}>
                    <Link
                      href={`/admin/companies/${companyId}/assets/${password.assetId}`}
                      style={{ color: 'var(--accent)' }}
                    >
                      {assetName ?? 'View asset'}
                    </Link>
                  </dd>
                </>
              )}
              <dt style={dt}>Folder</dt>
              <dd style={dd}>{folderName ?? 'Unfiled'}</dd>
              {password.tags.length > 0 && (
                <>
                  <dt style={dt}>Tags</dt>
                  <dd style={dd}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {password.tags.map((t) => (
                        <Tag key={t} tone="outline">
                          {t}
                        </Tag>
                      ))}
                    </div>
                  </dd>
                </>
              )}
              {detailsExpanded && (
                <>
                  {password.lastRotatedAt && (
                    <>
                      <dt style={dt}>Last rotated</dt>
                      <dd style={dd}><FormattedDate value={password.lastRotatedAt} /></dd>
                    </>
                  )}
                  {password.expiresAt && (
                    <>
                      <dt style={dt}>Expires</dt>
                      <dd style={dd}><FormattedCalendarDate value={password.expiresAt} /></dd>
                    </>
                  )}
                  {password.rotationReminderDays != null && (
                    <>
                      <dt style={dt}>Rotation reminder</dt>
                      <dd style={dd}>{password.rotationReminderDays} days</dd>
                    </>
                  )}
                  {(password.pwnedCount ?? 0) > 0 && (
                    <>
                      <dt style={dt}>HIBP</dt>
                      <dd style={dd}>
                        <Tag tone="danger">
                          {/* eslint-disable-next-line no-restricted-syntax -- locale digit grouping on a number, not a date */}
                          seen in {password.pwnedCount?.toLocaleString()} breaches
                        </Tag>
                      </dd>
                    </>
                  )}
                  <dt style={dt}>Created</dt>
                  <dd style={dd}><FormattedDateTime value={password.createdAt} /></dd>
                  <dt style={dt}>Updated</dt>
                  <dd style={dd}><FormattedDateTime value={password.updatedAt} /></dd>
                </>
              )}
            </dl>
          </Panel>

          <InternalAccessPanel
            password={password}
            canManage={canManageInternalAccess && !password.archivedAt}
            currentUserId={me.id}
            onEdit={() => setEditingInternalAccess(true)}
          />

          <VersionHistoryPanel
            companyId={companyId}
            passwordId={password.id}
            versions={versions}
            canManage={canManage}
            requiresReason={password.requireReasonToView}
            expanded={versionsExpanded}
            onToggleExpanded={() => setVersionsExpanded((v) => !v)}
          />
        </div>
      </div>

      {editingInternalAccess && (
        <InternalAccessDialog
          companyId={companyId}
          password={password}
          onClose={() => setEditingInternalAccess(false)}
          onSaved={() => {
            setEditingInternalAccess(false);
            toast.push('Internal access updated', 'ok');
            startTransition(() => router.refresh());
          }}
        />
      )}
    </>
  );
}

const dt = {
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase' as const,
  letterSpacing: 0.3,
  fontSize: 11,
};
const dd = { margin: 0, color: 'var(--text)' };

function InternalAccessPanel({
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

function InternalAccessDialog({
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
  const [restricted, setRestricted] = useState(
    password.restrictedToUserIds.length > 0,
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
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
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const user of data.items) {
          if (user.alwaysIncluded) next.add(user.id);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const selectableIds = useMemo(() => new Set(users.map((u) => u.id)), [users]);
  const alwaysIncludedIds = useMemo(
    () => new Set(users.filter((u) => u.alwaysIncluded).map((u) => u.id)),
    [users],
  );
  const unavailableIds = useMemo(
    () => Array.from(selectedIds).filter((id) => !selectableIds.has(id)),
    [selectedIds, selectableIds],
  );

  const toggleUser = (userId: string) => {
    if (alwaysIncludedIds.has(userId)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const submit = async () => {
    setErr(null);
    const nextIds = restricted
      ? Array.from(new Set([...Array.from(selectedIds), ...Array.from(alwaysIncludedIds)]))
      : [];
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
          <Btn
            size="sm"
            kind="primary"
            onClick={() => void submit()}
            disabled={busy || loading}
          >
            Save
          </Btn>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={checkboxLabel}>
          <input
            type="radio"
            checked={!restricted}
            onChange={() => setRestricted(false)}
          />
          All internal users with company access
        </label>
        <label style={checkboxLabel}>
          <input
            type="radio"
            checked={restricted}
            onChange={() => setRestricted(true)}
          />
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
                      {user.email} · {roleLabel(user.role)} ·{' '}
                      {accessSourceLabel(user.accessSource)}
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
            {unavailableIds.length === 1 ? '' : 's'} can no longer be selected.
            Clear the restriction or remove unavailable users before saving.
            <div style={{ marginTop: 6 }}>
              <Btn
                size="sm"
                kind="ghost"
                onClick={() =>
                  setSelectedIds(
                    (prev) =>
                      new Set(
                        Array.from(prev).filter(
                          (id) => selectableIds.has(id) || alwaysIncludedIds.has(id),
                        ),
                      ),
                  )
                }
              >
                Remove unavailable
              </Btn>
            </div>
          </div>
        )}

        {err && (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>
        )}
      </div>
    </Dialog>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: 'var(--muted)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        fontSize: 11,
        paddingTop: 6,
      }}
    >
      {children}
    </div>
  );
}

function VersionHistoryPanel({
  companyId,
  passwordId,
  versions,
  canManage,
  requiresReason,
  expanded,
  onToggleExpanded,
}: {
  companyId: string;
  passwordId: string;
  versions: PasswordVersionRow[];
  canManage: boolean;
  requiresReason: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const [, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  async function restore(version: number) {
    if (
      !window.confirm(
        `Restore version #${version} as a new version on top of history?\n\nThis is forward-only — a new version will be appended, the current version is kept in history.`,
      )
    )
      return;
    setBusy(version);
    const res = await apiFetch(
      `/companies/${companyId}/passwords/${passwordId}/versions/${version}/restore`,
      { method: 'POST' },
    );
    setBusy(null);
    if (!res.ok) {
      toast.push(
        (res.problem as { message?: string } | undefined)?.message ??
          'Restore failed',
        'danger',
      );
      return;
    }
    toast.push(`Restored from v${version}`, 'ok');
    startTransition(() => router.refresh());
  }

  const sorted = useMemo(
    () => [...versions].sort((a, b) => b.version - a.version),
    [versions],
  );
  const visible = expanded ? sorted : sorted.slice(0, 1);

  return (
    <Panel
      title="Version history"
      actions={
        sorted.length > 1 ? (
          <button
            type="button"
            onClick={onToggleExpanded}
            style={{
              border: 0,
              background: 'transparent',
              color: 'var(--accent)',
              fontSize: 11,
              cursor: 'pointer',
              padding: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {expanded ? 'Show latest' : 'View full history'}
          </button>
        ) : null
      }
    >
      {sorted.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>
          No versions yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visible.map((version) => (
            <VersionHistoryItem
              key={version.version}
              companyId={companyId}
              passwordId={passwordId}
              version={version}
              canManage={canManage}
              requiresReason={requiresReason}
              busy={busy === version.version}
              onRestore={() => void restore(version.version)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function VersionHistoryItem({
  companyId,
  passwordId,
  version,
  canManage,
  requiresReason,
  busy,
  onRestore,
}: {
  companyId: string;
  passwordId: string;
  version: PasswordVersionRow;
  canManage: boolean;
  requiresReason: boolean;
  busy: boolean;
  onRestore: () => void;
}) {
  const toast = useToast();
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [revealBusy, setRevealBusy] = useState(false);

  useEffect(() => {
    if (!plaintext) return;
    const timer = window.setTimeout(() => setPlaintext(null), 30_000);
    return () => window.clearTimeout(timer);
  }, [plaintext]);

  async function revealVersionPassword() {
    let reason: string | undefined;
    if (requiresReason) {
      const entered = window.prompt('Reason for revealing this historical password');
      if (entered === null) return;
      reason = entered.trim();
      if (!reason) {
        toast.push('A reason is required.', 'danger');
        return;
      }
    }
    setRevealBusy(true);
    const res = await apiFetch<{ password: string }>(
      `/companies/${companyId}/passwords/${passwordId}/versions/${version.version}/reveal`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    );
    setRevealBusy(false);
    if (!res.ok || !res.data) {
      toast.push(problemMessage(res.problem) ?? 'Reveal failed', 'danger');
      return;
    }
    setPlaintext(res.data.password);
  }

  async function copyVersionPassword() {
    if (!plaintext) return;
    const ok = await copyToClipboard(plaintext);
    toast.push(ok ? 'Historical password copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text)',
              fontWeight: 600,
            }}
          >
            v{version.version}
          </span>
          <span
            title={version.changedByName ?? version.changedBy}
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {version.changedByName ?? version.changedBy}
          </span>
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--dim)',
            whiteSpace: 'nowrap',
          }}
        >
          <FormattedShortDateTime value={version.createdAt} />
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div
          title={version.changeReason ?? undefined}
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11.5,
            color: 'var(--muted)',
          }}
        >
          {version.changedFields.length > 0
            ? version.changedFields.join(', ')
            : 'metadata'}
          {version.changeReason ? ` · ${version.changeReason}` : ''}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <TextAction
            disabled={revealBusy}
            onClick={() =>
              plaintext ? setPlaintext(null) : void revealVersionPassword()
            }
          >
            {plaintext ? 'Hide' : revealBusy ? 'Revealing...' : 'Reveal'}
          </TextAction>
          {canManage && (
            <TextAction disabled={busy} onClick={onRestore}>
              Restore
            </TextAction>
          )}
        </div>
      </div>
      {plaintext && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            padding: '5px 7px',
            borderRadius: 6,
            background: 'var(--elev)',
            border: '1px solid var(--line)',
          }}
        >
          <code
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12,
              color: 'var(--text)',
            }}
          >
            {plaintext}
          </code>
          <Btn size="sm" onClick={() => void copyVersionPassword()} title="Copy historical password">
            <Icon.copy size={14} />
          </Btn>
        </div>
      )}
    </div>
  );
}

function TextAction({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        border: 0,
        background: 'transparent',
        padding: 0,
        color: disabled ? 'var(--muted)' : 'var(--accent)',
        fontSize: 11.5,
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

function EditPasswordDialog({
  companyId,
  password,
  folders,
  generatorDefaults,
  onClose,
  onSaved,
}: {
  companyId: string;
  password: PasswordDetail;
  folders: PasswordFolderRow[];
  generatorDefaults: PasswordGeneratorDefaults;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [name, setName] = useState(password.name);
  const [username, setUsername] = useState(password.username ?? '');
  const [url, setUrl] = useState(password.url ?? '');
  const [newPassword, setNewPassword] = useState('');
  const [notes, setNotes] = useState(
    typeof password.notes === 'string' ? password.notes : '',
  );
  const [folderId, setFolderId] = useState<string | null>(password.folderId);
  const [visibleToClients, setVisibleToClients] = useState(
    password.visibleToClients,
  );
  const [requireReason, setRequireReason] = useState(
    password.requireReasonToView,
  );
  const [reason, setReason] = useState('');
  const [tags, setTags] = useState<TagChipDraft[]>(() =>
    password.tags.map((t) => ({ name: t })),
  );
  const [expiresAt, setExpiresAt] = useState<string>(() =>
    password.expiresAt ? password.expiresAt.slice(0, 10) : '',
  );
  const [rotationReminderDays, setRotationReminderDays] = useState<
    number | null
  >(password.rotationReminderDays);
  const [renderedAt] = useState(() => Date.now());
  const daysSinceRotation =
    password.lastRotatedAt != null
      ? Math.floor(
          (renderedAt - new Date(password.lastRotatedAt).getTime()) / 86_400_000,
        )
      : null;

  // TOTP editor — `keep` leaves the existing secret untouched (omits
  // `totp` from the PATCH body), `set` replaces/adds, `clear` removes.
  type TotpMode = 'keep' | 'set' | 'clear';
  const [totpMode, setTotpMode] = useState<TotpMode>('keep');
  const [totpSecret, setTotpSecret] = useState('');

  const submit = useCallback(async () => {
    setErr(null);
    const normalizedTotpSecret = totpSecret.replace(/\s+/g, '').toUpperCase();
    if (totpMode === 'set') {
      if (normalizedTotpSecret.length < 8) {
        setErr('TOTP secret must be at least 8 base32 characters.');
        return;
      }
      if (!/^[A-Z2-7=]+$/.test(normalizedTotpSecret)) {
        setErr('TOTP secret must be base32 (A–Z, 2–7).');
        return;
      }
    }

    setBusy(true);
    const body: Record<string, unknown> = {
      name: name.trim(),
      username: username.trim() || null,
      url: url.trim() || null,
      notes: notes.trim() ? notes : null,
      folderId,
      visibleToClients,
      requireReasonToView: requireReason,
      tags: toPlainNameList(tags),
      // Calendar-day input → midnight UTC on the picked day. The
      // server zeroes the time component anyway; this keeps the
      // round-trip stable so the date displayed in the panel matches
      // what the operator selected regardless of their timezone.
      expiresAt: expiresAt
        ? new Date(`${expiresAt}T00:00:00.000Z`).toISOString()
        : null,
      rotationReminderDays,
    };
    if (newPassword.length > 0) body.password = newPassword;
    if (reason.trim()) body.changeReason = reason.trim();
    if (totpMode === 'set') {
      body.totp = {
        secret: normalizedTotpSecret,
        algorithm: password.hasTotp ? password.totpAlgorithm : 'SHA1',
        digits: password.hasTotp ? password.totpDigits : 6,
        period: password.hasTotp ? password.totpPeriod : 30,
      };
    } else if (totpMode === 'clear') {
      body.totp = null;
    }

    const res = await apiFetch(
      `/companies/${companyId}/passwords/${password.id}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    setBusy(false);
    if (!res.ok) {
      setErr(
        (res.problem as { message?: string } | undefined)?.message ??
          'Update failed',
      );
      return;
    }
    onSaved();
  }, [
    companyId,
    password.id,
    name,
    username,
    url,
    notes,
    folderId,
    visibleToClients,
    requireReason,
    newPassword,
    reason,
    tags,
    expiresAt,
    rotationReminderDays,
    totpMode,
    totpSecret,
    password.hasTotp,
    password.totpAlgorithm,
    password.totpDigits,
    password.totpPeriod,
    onSaved,
  ]);

  const totpStatus =
    totpMode === 'clear'
      ? 'Authenticator will be removed'
      : totpMode === 'set'
        ? password.hasTotp
          ? 'Replacing authenticator'
          : 'Authenticator setup'
        : password.hasTotp
          ? 'Configured'
          : 'No authenticator configured';
  const totpDescription =
    totpMode === 'clear'
      ? 'The current TOTP secret will be removed on save.'
      : totpMode === 'set'
        ? 'Paste the base32 secret from the authenticator setup flow.'
        : password.hasTotp
          ? 'Authenticator codes are enabled for this credential.'
          : 'Add a TOTP secret when this credential also needs live codes.';

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit password"
      width={560}
      footer={
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <Btn size="sm" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            size="sm"
            kind="primary"
            onClick={() => void submit()}
            disabled={busy || name.trim().length === 0}
          >
            Save
          </Btn>
        </div>
      }
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (!busy && name.trim().length > 0) void submit();
          }
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <PasswordFormSection title="Credential">
          <Field label="Name" labelVariant="plain">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          <PasswordFieldGrid>
            <Field label="Username" labelVariant="plain">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field
              label="New password"
              labelVariant="plain"
              help="Leave blank to keep the current password unchanged."
            >
              <SecretInput
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                allowReveal
                generatorDefaults={generatorDefaults}
                onGenerate={setNewPassword}
              />
            </Field>
          </PasswordFieldGrid>
          <Field label="URL" labelVariant="plain">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
        </PasswordFormSection>

        <PasswordFormSection title="Two-Factor Authentication">
          <PasswordTotpCard
            status={totpStatus}
            description={totpDescription}
            tone={totpMode === 'clear' ? 'danger' : 'default'}
            actions={
              <>
                {totpMode !== 'keep' && (
                  <PasswordGhostAction onClick={() => setTotpMode('keep')}>
                    {password.hasTotp ? 'Keep current' : 'None'}
                  </PasswordGhostAction>
                )}
                {totpMode !== 'set' && (
                  <PasswordGhostAction onClick={() => setTotpMode('set')}>
                    {password.hasTotp ? 'Replace' : 'Add Authenticator'}
                  </PasswordGhostAction>
                )}
                {password.hasTotp && totpMode !== 'clear' && (
                  <PasswordGhostAction onClick={() => setTotpMode('clear')}>
                    Remove
                  </PasswordGhostAction>
                )}
              </>
            }
          >
            {totpMode === 'set' ? (
              <Field label="Base32 secret" labelVariant="plain">
                <Input
                  value={totpSecret}
                  onChange={(e) => setTotpSecret(e.target.value)}
                  placeholder="JBSWY3DPEHPK3PXP"
                  autoComplete="off"
                  spellCheck={false}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: 1,
                  }}
                />
              </Field>
            ) : null}
          </PasswordTotpCard>
        </PasswordFormSection>

        <PasswordFormSection title="Notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            aria-label="Notes"
          />
        </PasswordFormSection>

        <PasswordAdvancedDisclosure
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((open) => !open)}
        >
          <PasswordFormSection title="Organization">
            <PasswordFieldGrid>
              <Field label="Folder" labelVariant="plain">
                <Select
                  value={folderId ?? ''}
                  onChange={(e) => setFolderId(e.target.value || null)}
                >
                  <option value="">(no folder)</option>
                  {buildPasswordFolderOptions(folders).map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {formatFolderOptionLabel(opt)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tags" labelVariant="plain">
                <TagsInput value={tags} onChange={setTags} />
              </Field>
            </PasswordFieldGrid>
          </PasswordFormSection>

          <PasswordFormSection title="Security Policy">
            <PasswordFieldGrid>
              <Field label="Expires" labelVariant="plain">
                <Input
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </Field>
              <Field
                label="Rotation reminder"
                labelVariant="plain"
                help={
                  daysSinceRotation != null
                    ? `Last rotated ${daysSinceRotation === 0 ? 'today' : `${daysSinceRotation}d ago`}.`
                    : undefined
                }
              >
                <Select
                  value={
                    rotationReminderDays == null
                      ? ''
                      : String(rotationReminderDays)
                  }
                  onChange={(e) =>
                    setRotationReminderDays(
                      e.target.value === '' ? null : Number(e.target.value),
                    )
                  }
                >
                  <option value="">No reminder</option>
                  <option value="30">Every 30 days</option>
                  <option value="60">Every 60 days</option>
                  <option value="90">Every 90 days</option>
                  <option value="180">Every 180 days</option>
                  <option value="365">Every 365 days</option>
                </Select>
              </Field>
            </PasswordFieldGrid>
            <PasswordSettingChoice
              title="Client Portal Access"
              description="Controls whether client portal users can see this credential."
              value={visibleToClients ? 'visible' : 'hidden'}
              options={[
                { value: 'visible', label: 'Visible' },
                { value: 'hidden', label: 'Hidden' },
              ]}
              onChange={(value) => setVisibleToClients(value === 'visible')}
            />
            <PasswordSettingChoice
              title="Reveal Protection"
              description="Controls whether internal users must enter a reason before reveal."
              value={requireReason ? 'required' : 'not-required'}
              options={[
                { value: 'not-required', label: 'No reason' },
                { value: 'required', label: 'Require reason' },
              ]}
              onChange={(value) => setRequireReason(value === 'required')}
            />
          </PasswordFormSection>
        </PasswordAdvancedDisclosure>

        <PasswordFormSection title="Audit">
          <Field label="Change reason (optional)" labelVariant="plain">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Quarterly rotation"
          />
          </Field>
        </PasswordFormSection>
        {err && (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>
        )}
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

function formatCredentialUrl(value: string | null): string {
  if (!value) return '';
  const parse = (candidate: string) => {
    try {
      return new URL(candidate);
    } catch {
      return null;
    }
  };

  const parsed = parse(value) ?? parse(`https://${value}`);
  if (!parsed) return shortenPath(value.split(/[?#]/)[0] ?? value);

  const path = shortenPath(parsed.pathname);
  return `${parsed.hostname}${path === '/' ? '' : path}`;
}

function shortenPath(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? path;
  const segments = clean
    .split('/')
    .filter(Boolean)
    .filter((segment) => !isOpaqueUrlSegment(segment))
    .map((segment) => shortenUrlSegment(segment));

  const collapsed = segments.filter(
    (segment, index) => segment !== segments[index - 1],
  );
  return collapsed.length > 0 ? `/${collapsed.join('/')}` : '/';
}

function isOpaqueUrlSegment(segment: string): boolean {
  const decoded = decodeURIComponentSafe(segment);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) {
    return true;
  }
  if (/^[0-9a-f]{24,}$/i.test(decoded)) return true;
  if (/^[0-9a-f-]{24,}$/i.test(decoded) && /[0-9a-f]/i.test(decoded)) {
    return true;
  }
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(decoded)) return true;
  if (/^c[a-z0-9]{20,}$/i.test(decoded)) return true;
  return false;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function shortenUrlSegment(segment: string): string {
  if (segment.length <= 32) return segment;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
    return `${segment.slice(0, 8)}...`;
  }
  if (/^[0-9a-f-]{24,}$/i.test(segment)) return `${segment.slice(0, 8)}...`;
  return `${segment.slice(0, 24)}...${segment.slice(-8)}`;
}

function problemMessage(problem: unknown): string | null {
  if (!problem || typeof problem !== 'object') return null;
  const p = problem as { message?: unknown; detail?: unknown; title?: unknown };
  if (typeof p.message === 'string') return p.message;
  if (typeof p.detail === 'string') return p.detail;
  if (typeof p.title === 'string') return p.title;
  return null;
}

function roleLabel(role: PasswordAccessUser['role']): string {
  switch (role) {
    case 'SUPER_ADMIN':
      return 'super admin';
    case 'OPERATOR':
      return 'operator';
    case 'CONTRACTOR':
      return 'contractor';
  }
}

function accessSourceLabel(
  source: PasswordAccessUser['accessSource'],
): string {
  switch (source) {
    case 'super_admin':
      return 'always included';
    case 'global':
      return 'global access';
    case 'membership':
      return 'membership';
  }
}

/**
 * Extremely defensive notes renderer. Notes can be either a string
 * (legacy or simple plain-text) or a Tiptap-like JSON document. We
 * flatten text nodes out of the doc for display; rich formatting is a
 * later enhancement. Null/malformed payloads render as empty.
 */
function renderNotes(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'object') {
    const parts: string[] = [];
    walk(value as { content?: unknown[]; text?: string; type?: string }, parts);
    const joined = parts.join('\n').trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function walk(
  node: { content?: unknown[]; text?: string; type?: string },
  out: string[],
): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.text === 'string') out.push(node.text);
  const content = node.content;
  if (Array.isArray(content)) {
    for (const c of content) walk(c as never, out);
    if (node.type === 'paragraph' || node.type === 'heading') out.push('');
  }
}
