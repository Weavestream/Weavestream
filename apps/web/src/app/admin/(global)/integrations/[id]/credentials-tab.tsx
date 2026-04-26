'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  DriverDescriptor,
  IntegrationCompanyMappingDto,
  IntegrationDto,
  IntegrationStatusValue,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  Field,
  Icon,
  Input,
  Select,
  Tag,
  useToast,
} from '../../../../../components/ui';
import { DriverFieldsEditor } from '../driver-fields-editor';

const STATUSES: Array<{ value: IntegrationStatusValue; label: string }> = [
  { value: 'ACTIVE', label: 'Active — scheduled syncs run, manual sync allowed' },
  { value: 'PAUSED', label: 'Paused — scheduled syncs skipped, manual still allowed' },
  { value: 'DISABLED', label: 'Disabled — manual sync blocked, no scheduled runs' },
];

/**
 * Phase 11 — credentials tab.
 *
 * Edit the integration's name / status / schedule and rotate the
 * driver-defined config + secret bundles. Secret values are write-only
 * — the API never returns plaintext, only a fingerprint mask. The form
 * shows the fingerprint inline so the operator can verify they're
 * looking at the right credential set without exposing it.
 */
export function CredentialsTab({
  integration,
  mappings,
  driver,
}: {
  integration: IntegrationDto;
  mappings: IntegrationCompanyMappingDto[];
  driver: DriverDescriptor | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(integration.name);
  const [status, setStatus] = useState<IntegrationStatusValue>(integration.status);
  const [syncCron, setSyncCron] = useState(integration.syncCron ?? '');
  const [config, setConfig] = useState<Record<string, unknown>>({
    ...integration.config,
  });
  const [secret, setSecret] = useState<Record<string, unknown>>({});
  const [rotateSecret, setRotateSecret] = useState(false);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const enabledMappingCount = useMemo(
    () => mappings.filter((m) => m.enabled).length,
    [mappings],
  );
  const hasFieldMappings = integration.fieldMappingCount > 0;
  const cannotSync =
    integration.status === 'DISABLED' ||
    !integration.hasSecret ||
    !integration.assetLayoutId ||
    !hasFieldMappings ||
    enabledMappingCount === 0;
  const syncBlockedReason: string | null = !integration.hasSecret
    ? 'Add credentials below before running a sync.'
    : !integration.assetLayoutId || !hasFieldMappings
      ? 'No global field mappings yet — open the “Field mappings” tab.'
      : enabledMappingCount === 0
        ? 'No enabled organization mappings — open the “Organizations” tab.'
        : integration.status === 'DISABLED'
          ? 'Integration is disabled. Set status to Active or Paused to enable manual runs.'
          : null;

  const dirty = useMemo(() => {
    if (name.trim() !== integration.name) return true;
    if (status !== integration.status) return true;
    if ((syncCron.trim() || null) !== integration.syncCron) return true;
    if (JSON.stringify(config) !== JSON.stringify(integration.config)) return true;
    if (rotateSecret && Object.keys(secret).length > 0) return true;
    return false;
  }, [name, status, syncCron, config, secret, rotateSecret, integration]);

  async function save() {
    setError(null);
    setPending(true);
    const body: Record<string, unknown> = {};
    if (name.trim() !== integration.name) body.name = name.trim();
    if (status !== integration.status) body.status = status;
    if ((syncCron.trim() || null) !== integration.syncCron) {
      body.syncCron = syncCron.trim() === '' ? null : syncCron.trim();
    }
    if (JSON.stringify(config) !== JSON.stringify(integration.config)) {
      body.config = config;
    }
    if (rotateSecret && Object.keys(secret).length > 0) {
      body.secret = secret;
    }
    const res = await apiFetch<IntegrationDto>(
      `/admin/integrations/${integration.id}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    setPending(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as
        | { detail?: string; title?: string }
        | undefined;
      setError(problem?.detail ?? problem?.title ?? 'Could not save changes.');
      return;
    }
    toast.push('Integration saved.', 'ok');
    setRotateSecret(false);
    setSecret({});
    router.refresh();
  }

  async function testConnection() {
    setTesting(true);
    const res = await apiFetch<{ ok: boolean; details?: unknown }>(
      `/admin/integrations/${integration.id}/test`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    setTesting(false);
    if (!res.ok) {
      const problem = res.problem as
        | { detail?: string; title?: string }
        | undefined;
      toast.push(
        problem?.detail ?? problem?.title ?? 'Connection test failed.',
        'danger',
      );
      return;
    }
    toast.push('Connection OK.', 'ok');
  }

  async function triggerSync(dryRun: boolean) {
    setSyncing(true);
    const res = await apiFetch<{ id: string }>(
      `/admin/integrations/${integration.id}/sync`,
      { method: 'POST', body: JSON.stringify({ dryRun }) },
    );
    setSyncing(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as
        | { detail?: string; title?: string }
        | undefined;
      toast.push(
        problem?.detail ?? problem?.title ?? 'Could not enqueue sync.',
        'danger',
      );
      return;
    }
    toast.push(dryRun ? 'Dry run enqueued.' : 'Sync run enqueued.', 'ok');
    router.refresh();
  }

  async function destroy() {
    if (
      !window.confirm(
        `Delete integration "${integration.name}"?\n\nAssets currently linked to this integration will be released — they remain in Weavestream but lose their external link. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    const res = await apiFetch<null>(
      `/admin/integrations/${integration.id}`,
      { method: 'DELETE' },
    );
    setDeleting(false);
    if (!res.ok && res.status !== 204) {
      const problem = res.problem as
        | { detail?: string; title?: string }
        | undefined;
      toast.push(
        problem?.detail ?? problem?.title ?? 'Could not delete integration.',
        'danger',
      );
      return;
    }
    toast.push('Integration deleted, assets released.', 'ok');
    router.push('/admin/integrations');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h3 style={sectionHeaderStyle}>General</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 16,
          }}
        >
          <Field label="Display name" htmlFor="i-name">
            <Input
              id="i-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          </Field>
          <Field
            label="Status"
            htmlFor="i-status"
            help="Disabling stops manual + scheduled runs without losing config."
          >
            <Select
              id="i-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as IntegrationStatusValue)}
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field
          label="Sync schedule (cron)"
          htmlFor="i-cron"
          help="5-field UTC cron, e.g. '0 */6 * * *'. Leave blank for manual-only."
        >
          <Input
            id="i-cron"
            value={syncCron}
            onChange={(e) => setSyncCron(e.target.value)}
            placeholder="*/15 * * * *"
          />
        </Field>
      </section>

      {driver && driver.configFields.length > 0 && (
        <DriverFieldsEditor
          title="Configuration"
          fields={driver.configFields}
          values={config}
          onChange={setConfig}
        />
      )}

      {driver && driver.secretFields.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <h3 style={sectionHeaderStyle}>Credentials</h3>
            <SecretMask mask={integration.secretMask} />
          </div>
          {!rotateSecret ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Tag tone={integration.hasSecret ? 'ok' : 'warn'} dot>
                {integration.hasSecret ? 'configured' : 'missing'}
              </Tag>
              <Btn
                kind="outline"
                size="sm"
                icon={Icon.refresh}
                onClick={() => setRotateSecret(true)}
              >
                Rotate credentials
              </Btn>
              <Btn
                kind="ghost"
                size="sm"
                icon={Icon.zap}
                onClick={testConnection}
                loading={testing}
                disabled={!integration.hasSecret}
              >
                Test connection
              </Btn>
            </div>
          ) : (
            <>
              <DriverFieldsEditor
                title="New credential bundle"
                help="Provided values replace the existing bundle entirely. Leave a field blank to keep its prior value? — no, the bundle is replaced atomically; supply every required key."
                fields={driver.secretFields}
                values={secret}
                onChange={setSecret}
                isSecret
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn
                  kind="ghost"
                  size="sm"
                  onClick={() => {
                    setRotateSecret(false);
                    setSecret({});
                  }}
                >
                  Cancel rotation
                </Btn>
              </div>
            </>
          )}
        </section>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <h3 style={sectionHeaderStyle}>Run sync</h3>
          <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>
            {enabledMappingCount} enabled mapping
            {enabledMappingCount === 1 ? '' : 's'} ·{' '}
            {integration.fieldMappingCount} field mapping
            {integration.fieldMappingCount === 1 ? '' : 's'}
          </span>
        </div>
        <p style={runHelpStyle}>
          Trigger a one-off run across every enabled organization mapping.
          Use <strong>Dry run</strong> to preview record counts and
          conflicts without writing changes; <strong>Run sync now</strong>{' '}
          persists results.
        </p>
        {syncBlockedReason && <Tag tone="warn">{syncBlockedReason}</Tag>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn
            kind="outline"
            size="sm"
            icon={Icon.eye}
            onClick={() => triggerSync(true)}
            loading={syncing}
            disabled={cannotSync}
          >
            Dry run
          </Btn>
          <Btn
            kind="primary"
            size="sm"
            icon={Icon.sync}
            onClick={() => triggerSync(false)}
            loading={syncing}
            disabled={cannotSync}
          >
            Run sync now
          </Btn>
        </div>
      </section>

      {error && <Tag tone="danger">{error}</Tag>}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 10,
          borderTop: '1px solid var(--line)',
          paddingTop: 16,
          flexWrap: 'wrap',
        }}
      >
        <Btn
          kind="ghost"
          icon={Icon.trash}
          onClick={destroy}
          loading={deleting}
          style={{ color: 'var(--danger)' }}
        >
          Delete integration
        </Btn>
        <Btn
          kind="primary"
          onClick={save}
          loading={pending}
          disabled={!dirty}
        >
          Save changes
        </Btn>
      </div>
    </div>
  );
}

function SecretMask({ mask }: { mask: Record<string, string> | null }) {
  if (!mask || Object.keys(mask).length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        flexWrap: 'wrap',
        fontFamily: 'var(--font-mono)',
        fontSize: 11.5,
        color: 'var(--dim)',
      }}
    >
      {Object.entries(mask).map(([k, v]) => (
        <span key={k}>
          {k}: <span style={{ color: 'var(--text-2)' }}>{v}</span>
        </span>
      ))}
    </div>
  );
}

const sectionHeaderStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: -0.2,
  color: 'var(--text)',
};

const runHelpStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  color: 'var(--muted)',
};
