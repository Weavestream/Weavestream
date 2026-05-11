'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { PasswordGeneratorDefaults } from '@weavestream/shared';
import type {
  PasswordDetail,
  PasswordFolderRow,
  PasswordVersionRow,
} from '../../../../../../lib/server-api';
import { apiFetch } from '../../../../../../lib/api';
import { copyToClipboard } from '../../../../../../lib/clipboard';
import {
  Btn,
  DataTable,
  type DataColumn,
  Dialog,
  Field,
  Icon,
  Input,
  MobileCardRow,
  Panel,
  Select,
  Tag,
  Textarea,
  useToast,
} from '../../../../../../components/ui';
import { PasswordRevealField } from '../../../../../../components/passwords/password-reveal-field';
import { TotpCode } from '../../../../../../components/passwords/totp-code';
import { PasswordStrengthMeter } from '../../../../../../components/passwords/password-strength-meter';
import { SecretInput } from '../../../../../../components/passwords/secret-input';
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
  folders: PasswordFolderRow[];
  canManage: boolean;
  folderName: string | null;
  assetName: string | null;
  me: { id: string; role: string };
  generatorDefaults: PasswordGeneratorDefaults;
}

/**
 * Phase 10 — password detail client shell.
 *
 * Renders the read-only summary panels + a reveal field + live TOTP
 * code + versions list. An "Edit" button opens the dialog for
 * modifying metadata; the password field inside the edit dialog is
 * optional — omitting it preserves the current ciphertext without
 * bumping a new version.
 */
export function PasswordDetailClient({
  companyId,
  password,
  versions,
  folders,
  canManage,
  folderName,
  assetName,
  me,
  generatorDefaults,
}: Props) {
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

  async function copyUsername() {
    if (!password.username) return;
    const ok = await copyToClipboard(password.username);
    toast.push(ok ? 'Username copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  const notesHtml = useMemo(
    () => renderNotes(password.notes ?? null),
    [password.notes],
  );

  return (
    <>
      {canManage && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            marginBottom: 14,
            flexWrap: 'wrap',
          }}
        >
          <Btn size="sm" onClick={() => setEditing(true)}>
            <Icon.edit size={14} /> Edit
          </Btn>
          {password.archivedAt ? (
            <Btn size="sm" onClick={() => void restore()}>
              Restore
            </Btn>
          ) : (
            <Btn size="sm" onClick={() => void archive()}>
              Archive
            </Btn>
          )}
        </div>
      )}

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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    color: 'var(--text)',
                  }}
                >
                  {password.username ?? '—'}
                </code>
                {password.username && (
                  <Btn size="sm" onClick={() => void copyUsername()} title="Copy">
                    <Icon.copy size={12} />
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
              <div>
                {password.url ? (
                  <a
                    href={password.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--accent)', wordBreak: 'break-all' }}
                  >
                    {password.url}
                  </a>
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

          <Panel title="Version history" noPad>
            {versions.length === 0 ? (
              <div
                style={{
                  padding: 24,
                  color: 'var(--muted)',
                  fontSize: 13,
                  textAlign: 'center',
                }}
              >
                No versions yet — edits create an append-only history.
              </div>
            ) : (
              <VersionsTable
                companyId={companyId}
                passwordId={password.id}
                versions={versions}
                canManage={canManage}
              />
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

          <Panel title="Details">
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
              {password.lastRotatedAt && (
                <>
                  <dt style={dt}>Last rotated</dt>
                  <dd style={dd}>{fmtDate(password.lastRotatedAt)}</dd>
                </>
              )}
              {password.expiresAt && (
                <>
                  <dt style={dt}>Expires</dt>
                  <dd style={dd}>{fmtDate(password.expiresAt)}</dd>
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
                      seen in {password.pwnedCount?.toLocaleString()} breaches
                    </Tag>
                  </dd>
                </>
              )}
              <dt style={dt}>Created</dt>
              <dd style={dd}>{fmtDateTime(password.createdAt)}</dd>
              <dt style={dt}>Updated</dt>
              <dd style={dd}>{fmtDateTime(password.updatedAt)}</dd>
            </dl>
          </Panel>

          {password.restrictedToUserIds.length > 0 && (
            <Panel title="Access restricted">
              <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                {password.restrictedToUserIds.length} user
                {password.restrictedToUserIds.length === 1 ? '' : 's'} allowed
                to reveal this credential.
                {password.restrictedToUserIds.includes(me.id) && (
                  <> You&apos;re on the allow list.</>
                )}
              </p>
            </Panel>
          )}
        </div>
      </div>

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

const dt = {
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase' as const,
  letterSpacing: 0.3,
  fontSize: 11,
};
const dd = { margin: 0, color: 'var(--text)' };

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

type VersionRow = PasswordVersionRow & { id: string };

function VersionsTable({
  companyId,
  passwordId,
  versions,
  canManage,
}: {
  companyId: string;
  passwordId: string;
  versions: PasswordVersionRow[];
  canManage: boolean;
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

  // DataTable rows require a string `id`. Versions key naturally on the
  // numeric `version` column so we map to `${passwordId}-v${version}`.
  const rows: VersionRow[] = useMemo(
    () =>
      versions.map((v) => ({ ...v, id: `${passwordId}-v${v.version}` })),
    [versions, passwordId],
  );

  const columns: DataColumn<VersionRow>[] = [
    {
      id: 'version',
      header: '#',
      width: 60,
      mono: true,
      sortValue: (v) => v.version,
      render: (v) => `v${v.version}`,
    },
    {
      id: 'changedBy',
      header: 'Changed by',
      width: 180,
      sortValue: (v) => (v.changedByName ?? v.changedBy ?? '').toLowerCase(),
      render: (v) => (
        <span
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: 'inline-block',
            maxWidth: '100%',
          }}
        >
          {v.changedByName ?? v.changedBy}
        </span>
      ),
    },
    {
      id: 'fields',
      header: 'Fields',
      width: 220,
      sortValue: (v) => v.changedFields.length,
      render: (v) => (
        <div
          style={{
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
            maxWidth: 200,
          }}
        >
          {v.changedFields.map((f) => (
            <Tag key={f} tone="outline" style={{ fontSize: 10 }}>
              {f}
            </Tag>
          ))}
        </div>
      ),
    },
    {
      id: 'reason',
      header: 'Reason',
      sortValue: (v) => v.changeReason?.toLowerCase() ?? null,
      render: (v) => (
        <span
          style={{
            color: 'var(--muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: 'inline-block',
            maxWidth: '100%',
          }}
        >
          {v.changeReason ?? '—'}
        </span>
      ),
    },
    {
      id: 'when',
      header: 'When',
      width: 180,
      mono: true,
      sortValue: (v) => new Date(v.createdAt),
      render: (v) => (
        <span style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(v.createdAt)}</span>
      ),
    },
  ];

  if (canManage) {
    columns.push({
      id: 'actions',
      header: '',
      width: 120,
      align: 'right',
      sortable: false,
      render: (v) => (
        <Btn
          size="sm"
          kind="ghost"
          icon={Icon.refresh}
          disabled={busy === v.version}
          onClick={() => void restore(v.version)}
        >
          Restore
        </Btn>
      ),
    });
  }

  return (
    <DataTable
      columns={columns}
      rows={rows}
      defaultSort={{ columnId: 'version', direction: 'desc' }}
      renderMobileCard={(v) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text)',
                }}
              >
                v{v.version}
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: 'var(--text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {v.changedByName ?? v.changedBy}
              </span>
            </div>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
                whiteSpace: 'nowrap',
              }}
            >
              {fmtDateTime(v.createdAt)}
            </span>
          </div>
          {v.changedFields.length > 0 && (
            <MobileCardRow label="Fields">
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {v.changedFields.map((f) => (
                  <Tag key={f} tone="outline" style={{ fontSize: 10 }}>
                    {f}
                  </Tag>
                ))}
              </div>
            </MobileCardRow>
          )}
          {v.changeReason && (
            <MobileCardRow label="Reason">
              <span style={{ color: 'var(--muted)' }}>{v.changeReason}</span>
            </MobileCardRow>
          )}
          {canManage && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Btn
                size="sm"
                kind="ghost"
                icon={Icon.refresh}
                disabled={busy === v.version}
                onClick={() => void restore(v.version)}
              >
                Restore
              </Btn>
            </div>
          )}
        </div>
      )}
    />
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
  const daysSinceRotation =
    password.lastRotatedAt != null
      ? Math.floor(
          (Date.now() - new Date(password.lastRotatedAt).getTime()) / 86_400_000,
        )
      : null;

  // TOTP editor — `keep` leaves the existing secret untouched (omits
  // `totp` from the PATCH body), `set` replaces/adds, `clear` removes.
  type TotpMode = 'keep' | 'set' | 'clear';
  const [totpMode, setTotpMode] = useState<TotpMode>('keep');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpAlgorithm, setTotpAlgorithm] = useState<
    'SHA1' | 'SHA256' | 'SHA512'
  >(password.totpAlgorithm);
  const [totpDigits, setTotpDigits] = useState<number>(password.totpDigits);
  const [totpPeriod, setTotpPeriod] = useState<number>(password.totpPeriod);

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
        algorithm: totpAlgorithm,
        digits: totpDigits,
        period: totpPeriod,
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
    totpAlgorithm,
    totpDigits,
    totpPeriod,
    onSaved,
  ]);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit password"
      width={480}
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
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Username">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field
          label="New password"
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
        <Field label="URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field
          label="One-time password (TOTP)"
          help={
            password.hasTotp
              ? 'Current record has a TOTP configured. Replace or remove it here.'
              : 'Add a TOTP secret from your authenticator to generate live codes.'
          }
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <RadioPill
                checked={totpMode === 'keep'}
                onChange={() => setTotpMode('keep')}
                label={password.hasTotp ? 'Keep current' : 'None'}
              />
              <RadioPill
                checked={totpMode === 'set'}
                onChange={() => setTotpMode('set')}
                label={password.hasTotp ? 'Replace' : 'Add TOTP'}
              />
              {password.hasTotp && (
                <RadioPill
                  checked={totpMode === 'clear'}
                  onChange={() => setTotpMode('clear')}
                  label="Remove"
                />
              )}
            </div>
            {totpMode === 'set' && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: 10,
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  background: 'var(--panel-2)',
                }}
              >
                <Field label="Base32 secret">
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
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: 8,
                  }}
                >
                  <Field label="Algorithm">
                    <Select
                      value={totpAlgorithm}
                      onChange={(e) =>
                        setTotpAlgorithm(
                          e.target.value as 'SHA1' | 'SHA256' | 'SHA512',
                        )
                      }
                    >
                      <option value="SHA1">SHA1</option>
                      <option value="SHA256">SHA256</option>
                      <option value="SHA512">SHA512</option>
                    </Select>
                  </Field>
                  <Field label="Digits">
                    <Select
                      value={String(totpDigits)}
                      onChange={(e) => setTotpDigits(Number(e.target.value))}
                    >
                      <option value="6">6</option>
                      <option value="7">7</option>
                      <option value="8">8</option>
                    </Select>
                  </Field>
                  <Field label="Period (s)">
                    <Select
                      value={String(totpPeriod)}
                      onChange={(e) => setTotpPeriod(Number(e.target.value))}
                    >
                      <option value="30">30</option>
                      <option value="60">60</option>
                    </Select>
                  </Field>
                </div>
              </div>
            )}
            {totpMode === 'clear' && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--danger)',
                  padding: '6px 10px',
                  background: 'var(--danger-soft, rgba(220,38,38,0.08))',
                  borderRadius: 6,
                }}
              >
                The current TOTP secret will be removed on save. A new
                version row is written so it stays recoverable from history.
              </div>
            )}
          </div>
        </Field>
        <Field label="Notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </Field>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 10,
          }}
        >
          <Field label="Folder">
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
          <Field label="Tags">
            <TagsInput value={tags} onChange={setTags} />
          </Field>
          <Field label="Expires">
            <Input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </Field>
          <Field
            label="Rotation reminder"
            help={
              daysSinceRotation != null
                ? `Last rotated ${daysSinceRotation === 0 ? 'today' : `${daysSinceRotation}d ago`}.`
                : undefined
            }
          >
            <Select
              value={
                rotationReminderDays == null ? '' : String(rotationReminderDays)
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
        </div>
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={visibleToClients}
            onChange={(e) => setVisibleToClients(e.target.checked)}
          />
          Visible to client portal users
        </label>
        <label style={checkboxLabel}>
          <input
            type="checkbox"
            checked={requireReason}
            onChange={(e) => setRequireReason(e.target.checked)}
          />
          Require a reason to reveal
        </label>
        <Field label="Change reason (optional)">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Quarterly rotation"
          />
        </Field>
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

function RadioPill({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--line)'}`,
        background: checked ? 'var(--accent-soft, rgba(37,99,235,0.12))' : 'transparent',
        color: checked ? 'var(--accent)' : 'var(--text)',
        fontSize: 12,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        style={{ margin: 0 }}
      />
      {label}
    </label>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Format date + time as two separate locale calls and join manually.
// Avoids hydration mismatches caused by ICU version differences between
// Node and the browser (e.g. newer ICU inserts "at" instead of ", ").
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const datePart = d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const timePart = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${datePart}, ${timePart}`;
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
