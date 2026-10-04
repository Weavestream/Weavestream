'use client';

import { useCallback, useState } from 'react';
import {
  optionalHttpUrlError,
  type PasswordGeneratorDefaults,
  problemMessage,
} from '@weavestream/shared';
import type { PasswordDetail, PasswordFolderSchema } from '@weavestream/shared';
import { apiFetch } from '../../../../../../../lib/api';
import { Btn, Dialog, Field, Input, Select, Textarea } from '../../../../../../../components/ui';
import { SecretInput } from '../../../../../../../components/passwords/secret-input';
import {
  PasswordAdvancedDisclosure,
  PasswordFieldGrid,
  PasswordFormSection,
  PasswordGhostAction,
  PasswordSettingChoice,
  PasswordTotpCard,
} from '../../../../../../../components/passwords/password-form-layout';
import {
  TagsInput,
  toPlainNameList,
  type TagChipDraft,
} from '../../../../../../../components/tags/tags-input';
import {
  buildPasswordFolderOptions,
  formatFolderOptionLabel,
} from '../../../../../../../lib/password-folder-tree';

export function EditPasswordDialog({
  companyId,
  password,
  folders,
  generatorDefaults,
  onClose,
  onSaved,
}: {
  companyId: string;
  password: PasswordDetail;
  folders: PasswordFolderSchema[];
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
  const urlError = optionalHttpUrlError(url);
  const [newPassword, setNewPassword] = useState('');
  const [notes, setNotes] = useState(password.notes ?? '');
  const [folderId, setFolderId] = useState<string | null>(password.folderId);
  const [visibleToClients, setVisibleToClients] = useState(password.visibleToClients);
  const [requireReason, setRequireReason] = useState(password.requireReasonToView);
  const [reason, setReason] = useState('');
  const [tags, setTags] = useState<TagChipDraft[]>(() => password.tags.map((t) => ({ name: t })));
  const [expiresAt, setExpiresAt] = useState<string>(() =>
    password.expiresAt ? password.expiresAt.slice(0, 10) : '',
  );
  const [rotationReminderDays, setRotationReminderDays] = useState<number | null>(
    password.rotationReminderDays,
  );
  const [renderedAt] = useState(() => Date.now());
  const daysSinceRotation =
    password.lastRotatedAt != null
      ? Math.floor((renderedAt - new Date(password.lastRotatedAt).getTime()) / 86_400_000)
      : null;

  // TOTP editor — `keep` leaves the existing secret untouched (omits
  // `totp` from the PATCH body), `set` replaces/adds, `clear` removes.
  type TotpMode = 'keep' | 'set' | 'clear';
  const [totpMode, setTotpMode] = useState<TotpMode>('keep');
  const [totpSecret, setTotpSecret] = useState('');

  const submit = useCallback(async () => {
    setErr(null);
    if (urlError) return;
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
      expiresAt: expiresAt ? new Date(`${expiresAt}T00:00:00.000Z`).toISOString() : null,
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

    const res = await apiFetch(`/companies/${companyId}/passwords/${password.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(problemMessage(res.problem) ?? 'Update failed');
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
    urlError,
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
            disabled={busy || name.trim().length === 0 || urlError !== null}
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
            if (!busy && name.trim().length > 0 && !urlError) void submit();
          }
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <PasswordFormSection title="Credential">
          <Field label="Name" labelVariant="plain">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
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
          <Field
            label="URL"
            labelVariant="plain"
            htmlFor="password-edit-url"
            error={urlError ?? undefined}
          >
            <Input
              id="password-edit-url"
              type="url"
              inputMode="url"
              maxLength={2048}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
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
                  value={rotationReminderDays == null ? '' : String(rotationReminderDays)}
                  onChange={(e) =>
                    setRotationReminderDays(e.target.value === '' ? null : Number(e.target.value))
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
        {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
      </div>
    </Dialog>
  );
}
