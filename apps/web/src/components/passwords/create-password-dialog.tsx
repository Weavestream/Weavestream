'use client';

import { useCallback, useId, useState } from 'react';
import type { PasswordGeneratorDefaults } from '@weavestream/shared';
import {
  Btn,
  Dialog,
  Field,
  Icon,
  Input,
  Select,
  Textarea,
} from '../ui';
import { apiFetch } from '../../lib/api';
import type { PasswordFolderRow } from '../../lib/server-api';
import { SecretInput } from './secret-input';

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
  onClose,
  onCreated,
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
  onClose: () => void;
  onCreated: () => void;
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
  const [visibleToClients, setVisibleToClients] = useState(false);
  const [requireReason, setRequireReason] = useState(false);
  const [totpSecret, setTotpSecret] = useState('');
  const fieldSeed = useId().replace(/:/g, '');
  const accountFieldId = `ws-acct-${fieldSeed}`;
  const accountFieldName = `ws-acct-${fieldSeed}`;
  const secretFieldName = `ws-secret-${fieldSeed}`;

  const submit = useCallback(async () => {
    setErr(null);
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
    };
    if (totpSecret.trim()) {
      body.totp = {
        secret: totpSecret.trim().replace(/\s+/g, '').toUpperCase(),
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
      setErr(
        (res.problem as { message?: string } | undefined)?.message ??
          'Create failed',
      );
      return;
    }
    onCreated();
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
    totpSecret,
    onCreated,
  ]);

  const valid = name.trim().length > 0 && password.length > 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <Btn size="sm" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            size="sm"
            kind="primary"
            onClick={() => void submit()}
            disabled={!valid || busy}
          >
            Create
          </Btn>
        </div>
      }
      width={480}
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (valid && !busy) void submit();
          }
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
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
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <VaultField label="Account">
            <Input
              id={accountFieldId}
              name={accountFieldName}
              aria-label="Account"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </VaultField>
          <Field label="URL">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
        </div>
        <VaultField label="Password">
          <SecretInput
            name={secretFieldName}
            aria-label="Secret"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            allowReveal
            generatorDefaults={generatorDefaults}
            onGenerate={setPassword}
          />
        </VaultField>
        <Field label="Notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </Field>
        <Field label="TOTP secret (base32, optional)">
          <Input
            value={totpSecret}
            onChange={(e) => setTotpSecret(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field label="Folder">
          <Select
            value={selectedFolder ?? ''}
            onChange={(e) => setSelectedFolder(e.target.value || null)}
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

function VaultField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        aria-hidden="true"
        style={{
          display: 'block',
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
