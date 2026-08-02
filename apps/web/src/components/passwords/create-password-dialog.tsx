'use client';

import { useCallback, useId, useState } from 'react';
import { optionalHttpUrlError, type PasswordGeneratorDefaults } from '@weavestream/shared';
import { Btn, Dialog, Field, Icon, Input, Select, Textarea } from '../ui';
import { apiFetch } from '../../lib/api';
import type { PasswordFolderRow } from '../../lib/server-api';
import {
  buildPasswordFolderOptions,
  formatFolderOptionLabel,
} from '../../lib/password-folder-tree';
import { TagsInput, toPlainNameList, type TagChipDraft } from '../tags/tags-input';
import { SecretInput } from './secret-input';
import {
  PasswordAdvancedDisclosure,
  PasswordFieldGrid,
  PasswordFormSection,
  PasswordGhostAction,
  PasswordSettingChoice,
  PasswordTotpCard,
} from './password-form-layout';

/**
 * Shared "new credential" dialog.
 *
 * Used both from the admin vault browser (top-level "New password"
 * action) and inline on the asset detail page (the CredentialsPanel
 * "Attach credential" action). When `assetId` is set we render an
 * embed notice and cascade-archive is enforced by the API.
 *
 * Password input uses `SecretInput` (type="text" + text-security) so
 * Safari and password managers don't try to save the new credential
 * to the host OS keychain.
 */
export function CreatePasswordDialog({
  companyId,
  folders,
  folderId = null,
  assetId,
  generatorDefaults,
  onCloseAction,
  onCreatedAction,
  title = 'New password',
}: {
  companyId: string;
  folders: PasswordFolderRow[];
  folderId?: string | null;
  assetId?: string;
  /**
   * Workspace-wide defaults used to seed the generator popover. When
   * omitted the password field still accepts manual input; the wand
   * button is only rendered when this is supplied.
   */
  generatorDefaults?: PasswordGeneratorDefaults;
  // Next.js 16 RSC boundary: this dialog is reachable from Server
  // Components (e.g. the asset CredentialsPanel), so callback props must
  // use the `Action` suffix to satisfy the "use client" serializable-
  // props check. They remain ordinary client-side callbacks.
  onCloseAction: () => void;
  onCreatedAction: () => void;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [url, setUrl] = useState('');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string | null>(folderId);
  // Secure-by-default (WS-003): new credentials start internal/private.
  // Sharing with the client portal is an explicit opt-in below.
  const [visibleToClients, setVisibleToClients] = useState(false);
  const [requireReason, setRequireReason] = useState(false);
  const [totpSecret, setTotpSecret] = useState('');
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [tags, setTags] = useState<TagChipDraft[]>([]);
  const [expiresAt, setExpiresAt] = useState<string>('');
  const [rotationReminderDays, setRotationReminderDays] = useState<number | null>(null);
  const fieldSeed = useId().replace(/:/g, '');
  const accountFieldId = `ws-acct-${fieldSeed}`;
  const accountFieldName = `ws-acct-${fieldSeed}`;
  const secretFieldName = `ws-secret-${fieldSeed}`;
  const urlError = optionalHttpUrlError(url);

  const submit = useCallback(async () => {
    setErr(null);
    if (urlError) return;
    const normalizedTotpSecret = totpSecret.replace(/\s+/g, '').toUpperCase();
    if (totpEnabled) {
      if (normalizedTotpSecret.length < 8) {
        setErr('TOTP secret must be at least 8 base32 characters.');
        return;
      }
      if (!/^[A-Z2-7=]+$/.test(normalizedTotpSecret)) {
        setErr('TOTP secret must be base32 (A-Z, 2-7).');
        return;
      }
    }

    setBusy(true);
    const body: Record<string, unknown> = {
      name: name.trim(),
      username: username.trim() || null,
      url: url.trim() || null,
      password,
      notes: notes.trim() ? notes : null,
      folderId: selectedFolder,
      assetId: assetId ?? null,
      visibleToClients,
      requireReasonToView: requireReason,
      tags: toPlainNameList(tags),
      // `<input type="date">` emits a yyyy-mm-dd local-date string. The
      // API expects a full ISO timestamp; midnight UTC is the right
      // anchor since the field carries calendar-day semantics.
      expiresAt: expiresAt ? new Date(`${expiresAt}T00:00:00.000Z`).toISOString() : null,
      rotationReminderDays,
    };
    if (totpEnabled) {
      body.totp = {
        secret: normalizedTotpSecret,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      };
    }
    const res = await apiFetch(`/companies/${companyId}/passwords`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setErr((res.problem as { message?: string } | undefined)?.message ?? 'Create failed');
      return;
    }
    onCreatedAction();
  }, [
    companyId,
    name,
    username,
    url,
    password,
    notes,
    selectedFolder,
    assetId,
    visibleToClients,
    requireReason,
    totpEnabled,
    totpSecret,
    tags,
    expiresAt,
    rotationReminderDays,
    onCreatedAction,
    urlError,
  ]);

  const valid = name.trim().length > 0 && password.length > 0 && !urlError;

  return (
    <Dialog
      open
      onClose={onCloseAction}
      title={title}
      footer={
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <Btn size="sm" onClick={onCloseAction}>
            Cancel
          </Btn>
          <Btn size="sm" kind="primary" onClick={() => void submit()} disabled={!valid || busy}>
            Create
          </Btn>
        </div>
      }
      width={560}
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (valid && !busy) void submit();
          }
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        {assetId && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              padding: '6px 8px',
              background: 'var(--panel-2)',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon.lock size={12} /> Attached to this asset — archives with it.
          </div>
        )}
        <PasswordFormSection title="Credential">
          <Field label="Name" labelVariant="plain">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <PasswordFieldGrid>
            <Field label="Username" labelVariant="plain">
              <Input
                id={accountFieldId}
                name={accountFieldName}
                aria-label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Password" labelVariant="plain">
              <SecretInput
                name={secretFieldName}
                aria-label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                allowReveal
                generatorDefaults={generatorDefaults}
                onGenerate={setPassword}
              />
            </Field>
          </PasswordFieldGrid>
          <Field
            label="URL"
            labelVariant="plain"
            htmlFor={`${fieldSeed}-url`}
            error={urlError ?? undefined}
          >
            <Input
              id={`${fieldSeed}-url`}
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
            status={totpEnabled ? 'Authenticator setup' : 'No authenticator configured'}
            description={
              totpEnabled
                ? 'Paste the base32 secret from the authenticator setup flow.'
                : 'Add a TOTP secret when this credential also needs live codes.'
            }
            actions={
              totpEnabled ? (
                <PasswordGhostAction
                  onClick={() => {
                    setTotpEnabled(false);
                    setTotpSecret('');
                  }}
                >
                  Remove
                </PasswordGhostAction>
              ) : (
                <PasswordGhostAction onClick={() => setTotpEnabled(true)}>
                  Add Authenticator
                </PasswordGhostAction>
              )
            }
          >
            {totpEnabled ? (
              <Field label="Base32 secret" labelVariant="plain">
                <Input
                  value={totpSecret}
                  onChange={(e) => setTotpSecret(e.target.value)}
                  placeholder="JBSWY3DPEHPK3PXP"
                  autoComplete="off"
                  spellCheck={false}
                  style={{ fontFamily: 'var(--font-mono)', letterSpacing: 1 }}
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
                  value={selectedFolder ?? ''}
                  onChange={(e) => setSelectedFolder(e.target.value || null)}
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
              <Field label="Rotation reminder" labelVariant="plain">
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
            {visibleToClients && (
              <div
                role="alert"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  fontSize: 12,
                  color: 'var(--warn)',
                  padding: '6px 8px',
                  background: 'var(--warn-soft)',
                  borderRadius: 6,
                }}
              >
                <Icon.warn size={12} />
                <span>
                  Client portal users will be able to see and reveal this credential. Only enable
                  this for credentials you intend to share.
                </span>
              </div>
            )}
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
        {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}
      </div>
    </Dialog>
  );
}
