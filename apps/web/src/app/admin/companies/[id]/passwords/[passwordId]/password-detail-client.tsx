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
  Dialog,
  Field,
  Icon,
  Input,
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

interface Props {
  companyId: string;
  password: PasswordDetail;
  versions: PasswordVersionRow[];
  folders: PasswordFolderRow[];
  canManage: boolean;
  folderName: string | null;
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
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)',
          gap: 14,
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
              <dt style={dt}>Folder</dt>
              <dd style={dd}>{folderName ?? 'Unfiled'}</dd>
              <dt style={dt}>Tags</dt>
              <dd style={dd}>
                {password.tags.length === 0 ? (
                  <span style={{ color: 'var(--muted)' }}>—</span>
                ) : (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {password.tags.map((t) => (
                      <Tag key={t} tone="outline">
                        {t}
                      </Tag>
                    ))}
                  </div>
                )}
              </dd>
              <dt style={dt}>Last rotated</dt>
              <dd style={dd}>{fmtDate(password.lastRotatedAt)}</dd>
              <dt style={dt}>Expires</dt>
              <dd style={dd}>{fmtDate(password.expiresAt)}</dd>
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

          {password.assetId && (
            <Panel title="Embedded on asset">
              <Link
                href={`/admin/companies/${companyId}/assets/${password.assetId}`}
                style={{ color: 'var(--accent)', fontSize: 13 }}
              >
                View linked asset →
              </Link>
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  marginTop: 6,
                  lineHeight: 1.5,
                }}
              >
                Permissions inherit from this asset. Archiving the asset will
                automatically archive this credential.
              </p>
            </Panel>
          )}

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

  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 12.5,
        tableLayout: 'fixed',
      }}
    >
      <colgroup>
        <col style={{ width: 48 }} />
        <col style={{ width: 180 }} />
        <col style={{ width: 200 }} />
        <col />
        <col style={{ width: 160 }} />
        <col style={{ width: 90 }} />
      </colgroup>
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
          <th style={vth}>#</th>
          <th style={vth}>Changed by</th>
          <th style={vth}>Fields</th>
          <th style={vth}>Reason</th>
          <th style={vth}>When</th>
          <th style={vth}></th>
        </tr>
      </thead>
      <tbody>
        {versions.map((v) => (
          <tr key={v.version} style={{ borderTop: '1px solid var(--line)' }}>
            <td style={vtd}>v{v.version}</td>
            <td style={vtdNoWrap}>{v.changedByName ?? v.changedBy}</td>
            <td style={vtd}>
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
            </td>
            <td
              style={{
                ...vtd,
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {v.changeReason ?? '—'}
            </td>
            <td style={{ ...vtdNoWrap, fontFamily: 'var(--font-mono)' }}>
              {fmtDateTime(v.createdAt)}
            </td>
            <td style={{ ...vtd, textAlign: 'right' }}>
              {canManage && (
                <Btn
                  size="sm"
                  disabled={busy === v.version}
                  onClick={() => void restore(v.version)}
                >
                  Restore
                </Btn>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const vth = { padding: '8px 12px', fontWeight: 500 } as const;
const vtd = { padding: '8px 12px', verticalAlign: 'top' } as const;
const vtdNoWrap = {
  ...vtd,
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden' as const,
  textOverflow: 'ellipsis' as const,
};

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
      <form
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && name.trim().length > 0) void submit();
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Username">
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="URL">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
        </div>
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
        <Field label="Folder">
          <Select
            value={folderId ?? ''}
            onChange={(e) => setFolderId(e.target.value || null)}
          >
            <option value="">(no folder)</option>
            {folders
              .filter((f) => !f.archivedAt)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </Select>
        </Field>
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
        <button type="submit" style={{ display: 'none' }} tabIndex={-1} />
      </form>
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
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
