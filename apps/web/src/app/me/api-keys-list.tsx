'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ApiKeySummary, CreatedApiKey } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { FormattedRelative } from '../../lib/timezone-context';
import {
  Btn,
  Checkbox,
  DataTable,
  Dialog,
  ErrorBanner,
  Field,
  Icon,
  Input,
  MobileCardRow,
  Select,
  Tag,
  useToast,
  type DataColumn,
} from '../../components/ui';

/** Expiry choices offered in the UI. The API also accepts any 1–3650. */
const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
] as const;

/**
 * Self-service API keys. A key acts as you, with your permissions, until it
 * expires or is revoked. Creating one asks for MFA again (step-up); the token
 * is shown exactly once and never stored in the browser.
 */
export function ApiKeysList({
  keys,
  loadFailed = false,
}: {
  keys: ApiKeySummary[];
  /** The server-side list fetch failed; say so rather than show "No API keys". */
  loadFailed?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ApiKeySummary | null>(null);

  async function revoke(k: ApiKeySummary) {
    setRevoking(k.id);
    try {
      const res = await apiFetch(`/me/api-keys/${k.id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.push('Could not revoke the key.', 'danger');
        return;
      }
      toast.push(`Revoked “${k.name}”.`, 'ok');
      router.refresh();
    } catch {
      toast.push('Could not revoke the key.', 'danger');
    } finally {
      setRevoking(null);
    }
  }

  const columns: DataColumn<ApiKeySummary>[] = [
    {
      id: 'name',
      header: 'Name',
      sortValue: (k) => k.name.toLowerCase(),
      render: (k) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{k.name}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--dim)' }}>
            ws_{k.keyId}_…
          </span>
        </div>
      ),
    },
    {
      id: 'vault',
      header: 'Passwords',
      width: 150,
      sortValue: (k) => (k.allowPasswordReveal ? 1 : 0),
      render: (k) => <VaultTag allow={k.allowPasswordReveal} />,
    },
    {
      id: 'lastUsed',
      header: 'Last used',
      mono: true,
      width: 140,
      sortValue: (k) => (k.lastUsedAt ? new Date(k.lastUsedAt) : null),
      render: (k) => (
        <span style={{ color: 'var(--dim)' }}>
          {k.lastUsedAt ? <FormattedRelative value={k.lastUsedAt} /> : 'never'}
        </span>
      ),
    },
    {
      id: 'expires',
      header: 'Expires',
      mono: true,
      width: 140,
      sortValue: (k) => (k.expiresAt ? new Date(k.expiresAt) : null),
      render: (k) => <ExpiresCell expiresAt={k.expiresAt} />,
    },
    {
      id: 'actions',
      header: '',
      width: 110,
      render: (k) => (
        <Btn
          kind="outline"
          size="sm"
          loading={revoking === k.id}
          aria-label={`Revoke ${k.name}`}
          onClick={() => setConfirming(k)}
        >
          Revoke
        </Btn>
      ),
    },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 10,
          borderBottom: '1px solid var(--line)',
        }}
      >
        <span style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: 560 }}>
          A key acts as you, with your permissions, for scripts and AI agents. It cannot
          change your password, MFA, sessions, users or access rules. Changing your password
          revokes every key.
        </span>
        <Btn kind="primary" size="sm" icon={Icon.key} onClick={() => setCreateOpen(true)}>
          New API key
        </Btn>
      </div>

      {loadFailed && (
        <div style={{ padding: 10 }}>
          <ErrorBanner title="Could not load your API keys." detail="Reload the page to try again.">
            <Btn kind="outline" size="sm" onClick={() => router.refresh()}>
              Retry
            </Btn>
          </ErrorBanner>
        </div>
      )}
      {!loadFailed && (
      <DataTable
        columns={columns}
        rows={keys}
        empty="No API keys."
        renderMobileCard={(k) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ color: 'var(--text)', fontWeight: 600, fontSize: 14 }}>{k.name}</div>
            <VaultTag allow={k.allowPasswordReveal} />
            <MobileCardRow label="Last used" mono>
              {k.lastUsedAt ? <FormattedRelative value={k.lastUsedAt} /> : 'never'}
            </MobileCardRow>
            <MobileCardRow label="Expires" mono>
              <ExpiresCell expiresAt={k.expiresAt} />
            </MobileCardRow>
            <Btn
              kind="outline"
              size="sm"
              loading={revoking === k.id}
              aria-label={`Revoke ${k.name}`}
              onClick={() => setConfirming(k)}
            >
              Revoke
            </Btn>
          </div>
        )}
      />
      )}

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Revoke API key"
        width={440}
        footer={
          <>
            <Btn kind="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Btn>
            <Btn
              kind="danger"
              onClick={() => {
                const k = confirming;
                setConfirming(null);
                if (k) void revoke(k);
              }}
            >
              Revoke
            </Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Revoke <strong>{confirming?.name}</strong>? Anything using it stops working
          immediately. This cannot be undone.
        </p>
      </Dialog>

      <CreateKeyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(k) => {
          setCreateOpen(false);
          setCreated(k);
          router.refresh();
        }}
      />
      <TokenOnceDialog created={created} onClose={() => setCreated(null)} />
    </div>
  );
}

/** The list includes expired keys (the server only drops revoked ones). */
function ExpiresCell({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <span style={{ color: 'var(--dim)' }}>never</span>;
  if (new Date(expiresAt).getTime() <= Date.now()) return <Tag tone="danger">expired</Tag>;
  return (
    <span style={{ color: 'var(--dim)' }}>
      <FormattedRelative value={expiresAt} />
    </span>
  );
}

function VaultTag({ allow }: { allow: boolean }) {
  return allow ? <Tag tone="warn">can reveal</Tag> : <Tag tone="outline">no reveal</Tag>;
}

function CreateKeyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (k: CreatedApiKey) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<(typeof EXPIRY_OPTIONS)[number]['value']>('365');
  const [allowReveal, setAllowReveal] = useState(false);
  const [pending, setPending] = useState(false);

  function reset() {
    setName('');
    setExpiry('365');
    setAllowReveal(false);
  }

  async function submit() {
    setPending(true);
    try {
      const res = await apiFetch<CreatedApiKey>('/me/api-keys', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          expiresInDays: expiry === 'never' ? null : Number(expiry),
          allowPasswordReveal: allowReveal,
        }),
      });
      if (!res.ok || !res.data) {
        // Step-up gated: a dismissed MFA prompt is the user declining.
        if (res.stepUpCancelled) return;
        const problem = res.problem as { detail?: string; title?: string } | undefined;
        toast.push(problem?.detail ?? problem?.title ?? 'Could not create the key.', 'danger');
        return;
      }
      reset();
      onCreated(res.data);
    } catch {
      toast.push('Could not create the key.', 'danger');
    } finally {
      setPending(false);
    }
  }

  function close() {
    // While the POST is in flight the dialog must stay open: closing it would
    // drop the one-time token when the response lands.
    if (pending) return;
    reset();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New API key"
      width={480}
      footer={
        <>
          <Btn kind="outline" onClick={close} disabled={pending}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            loading={pending}
            disabled={name.trim().length === 0}
            onClick={submit}
          >
            Create key
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Name" htmlFor="api-key-name" help="What will use it, e.g. “MCP on laptop”.">
          <Input
            id="api-key-name"
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Expires" htmlFor="api-key-expiry">
          <Select
            id="api-key-expiry"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as typeof expiry)}
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox
          label="Allow this key to reveal stored passwords"
          checked={allowReveal}
          onChange={setAllowReveal}
          hint="Off by default. Leave it off for AI agents: a leaked key could then read every password you can."
        />
      </div>
    </Dialog>
  );
}

function TokenOnceDialog({
  created,
  onClose,
}: {
  created: CreatedApiKey | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.push('Clipboard unavailable. Select the key and copy it manually.', 'warn');
    }
  }

  return (
    <Dialog
      open={created !== null}
      // Escape and backdrop clicks do nothing here: the token is shown once,
      // so only an explicit Done may discard it.
      onClose={() => undefined}
      title="Copy your API key"
      width={520}
      footer={
        <>
          <Btn kind="outline" onClick={copy}>
            {copied ? 'Copied' : 'Copy key'}
          </Btn>
          <Btn kind="primary" onClick={onClose}>
            Done
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          This is the only time the key is shown. Store it in your password manager. Send it as
          <code style={{ fontFamily: 'var(--font-mono)' }}> Authorization: Bearer &lt;key&gt;</code>.
        </p>
        {created && (
          <code
            style={{
              display: 'block',
              padding: 12,
              background: 'var(--panel-2)',
              border: '1px solid var(--line-2)',
              borderRadius: 8,
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {created.token}
          </code>
        )}
      </div>
    </Dialog>
  );
}
