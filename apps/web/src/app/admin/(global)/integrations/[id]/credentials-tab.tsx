'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  DriverDescriptor,
  IntegrationCompanyMappingDto,
  IntegrationDto,
  IntegrationStatusValue,
} from '@weavestream/shared';
import { problemMessage } from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  Checkbox,
  Field,
  Icon,
  Input,
  Select,
  Tag,
  useToast,
} from '../../../../../components/ui';
import {
  SyncScheduleSelect,
  syncScheduleHelp,
} from '../../../../../components/integrations/sync-schedule';
import { DriverFieldsEditor } from '../driver-fields-editor';
import { safeIntegrationProblemMessage } from '../integration-feedback';
import { credentialsReady } from '../integration-credentials';
import { ApiKeySetupGuide } from './api-key-setup-guide';
import { CustomApiConfig } from '../custom-api/custom-api-config';
import {
  cleanDefinition,
  customApiSavePlan,
  draftFromConfig,
  planHasChanges,
  type CustomApiDraft,
} from '../custom-api/definition-draft';

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
  syncHoldCount = 0,
}: {
  integration: IntegrationDto;
  mappings: IntegrationCompanyMappingDto[];
  driver: DriverDescriptor | null;
  /** Open sync holds; when there are any, the run control offers to accept them. */
  syncHoldCount?: number;
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
  const [acceptChanges, setAcceptChanges] = useState(false);

  const enabledMappingCount = useMemo(
    () => mappings.filter((m) => m.enabled).length,
    [mappings],
  );
  // Phase 11.1 — at least one enabled resource must have a layout AND at
  // least one field mapping for the runner to do anything.
  const syncableResources = useMemo(
    () =>
      integration.resources.filter(
        (r) => r.enabled && r.assetLayoutId && r.fieldMappingCount > 0,
      ),
    [integration.resources],
  );
  const hasSyncableResource = syncableResources.length > 0;
  const totalFieldMappings = useMemo(
    () =>
      integration.resources.reduce((sum, r) => sum + r.fieldMappingCount, 0),
    [integration.resources],
  );
  const ready = credentialsReady(integration);
  const cannotSync =
    integration.status === 'DISABLED' ||
    !ready ||
    !hasSyncableResource ||
    enabledMappingCount === 0;
  const syncBlockedReason: string | null = !ready
    ? driver?.oauth
      ? 'Connect a client tenant on the Connections tab before running a sync.'
      : 'Add credentials below before running a sync.'
    : !hasSyncableResource
      ? 'No resource is fully configured — open a resource tab to pick a layout and field mappings.'
      : enabledMappingCount === 0
        ? 'No enabled organization mappings — open the “Organizations” tab.'
        : integration.status === 'DISABLED'
          ? 'Integration is disabled. Set status to Active or Paused to enable manual runs.'
          : null;

  // Custom API: the config is an API definition; its save rules (which
  // secret keys, when to clear the secret) come from the definition.
  const apiDefinition = driver?.capabilities.apiDefinition === true;
  const plan = useMemo(
    () =>
      apiDefinition
        ? customApiSavePlan({
            saved: integration.config,
            hasSecret: integration.hasSecret,
            draft: draftFromConfig(config),
            values: secret,
            rotate: rotateSecret,
          })
        : null,
    [apiDefinition, integration.config, integration.hasSecret, config, secret, rotateSecret],
  );

  const dirty = useMemo(() => {
    if (name.trim() !== integration.name) return true;
    if (status !== integration.status) return true;
    if ((syncCron.trim() || null) !== integration.syncCron) return true;
    if (plan) return planHasChanges(plan);
    if (JSON.stringify(config) !== JSON.stringify(integration.config)) return true;
    if (rotateSecret && Object.keys(secret).length > 0) return true;
    return false;
  }, [name, status, syncCron, config, secret, rotateSecret, integration, plan]);

  async function save() {
    setError(null);
    setPending(true);
    const body: Record<string, unknown> = {};
    if (name.trim() !== integration.name) body.name = name.trim();
    if (status !== integration.status) body.status = status;
    if ((syncCron.trim() || null) !== integration.syncCron) {
      body.syncCron = syncCron.trim() === '' ? null : syncCron.trim();
    }
    if (plan) {
      if (plan.configChanged) body.config = cleanDefinition(draftFromConfig(config));
      Object.assign(body, plan.secretPatch);
    } else {
      if (JSON.stringify(config) !== JSON.stringify(integration.config)) {
        body.config = config;
      }
      if (rotateSecret && Object.keys(secret).length > 0) {
        body.secret = secret;
      }
    }
    const res = await apiFetch<IntegrationDto>(
      `/admin/integrations/${integration.id}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    setPending(false);
    if (!res.ok || !res.data) {
      const message = safeIntegrationProblemMessage(
        res.problem,
        'Could not save changes.',
        rotateSecret || plan?.entering ? secret : {},
      );
      setError(message);
      toast.push(message, 'danger');
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
      toast.push(
        problemMessage(res.problem) ?? 'Connection test failed.',
        'danger',
      );
      return;
    }
    toast.push('Connection OK.', 'ok');
  }

  async function triggerSync(dryRun: boolean) {
    setSyncing(true);
    // Accepting applies to a real run only; the API makes it a full sync.
    const accept = !dryRun && acceptChanges && syncHoldCount > 0;
    const res = await apiFetch<{ id: string }>(
      `/admin/integrations/${integration.id}/sync`,
      {
        method: 'POST',
        body: JSON.stringify(accept ? { dryRun, acceptSourceChanges: true } : { dryRun }),
      },
    );
    setSyncing(false);
    if (!res.ok || !res.data) {
      toast.push(
        problemMessage(res.problem) ?? 'Could not enqueue sync.',
        'danger',
      );
      return;
    }
    toast.push(
      dryRun
        ? 'Dry run enqueued.'
        : accept
          ? 'Full sync enqueued. It accepts the held changes.'
          : 'Sync run enqueued.',
      'ok',
    );
    if (accept) setAcceptChanges(false);
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
      toast.push(
        problemMessage(res.problem) ?? 'Could not delete integration.',
        'danger',
      );
      return;
    }
    toast.push('Integration deleted, assets released.', 'ok');
    router.push('/admin/integrations');
  }

  // Test connection checks the saved integration. With unsaved definition
  // changes its result would describe the old definition, so it waits for
  // Save (the definition editor's own Test buttons use the form).
  const testConnectionButton = (
    <Btn
      kind="ghost"
      size="sm"
      icon={Icon.zap}
      onClick={testConnection}
      loading={testing}
      disabled={!ready || (plan !== null && planHasChanges(plan))}
    >
      Test connection
    </Btn>
  );

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
          label="Sync schedule"
          htmlFor="i-cron"
          help={syncScheduleHelp(
            driver?.capabilities.kind === 'security' ? 'security' : 'pull',
            syncCron,
          )}
        >
          <SyncScheduleSelect
            id="i-cron"
            value={syncCron}
            onChange={setSyncCron}
          />
        </Field>
      </section>

      {driver && plan && (
        <CustomApiConfig
          integration={integration}
          mappings={mappings}
          draft={draftFromConfig(config)}
          onDraftChange={(next: CustomApiDraft) => setConfig(next as unknown as Record<string, unknown>)}
          secret={secret}
          onSecretChange={setSecret}
          rotate={rotateSecret}
          onRotateChange={setRotateSecret}
          plan={plan}
          secretMask={<SecretMask mask={integration.secretMask} />}
          testConnection={testConnectionButton}
        />
      )}

      {driver && !plan && driver.configFields.length > 0 && (
        <DriverFieldsEditor
          title="Configuration"
          fields={driver.configFields}
          values={config}
          onChange={setConfig}
        />
      )}

      {driver && !driver.oauth && driver.setupGuide && driver.setupGuide.length > 0 && (
        <ApiKeySetupGuide integrationId={integration.id} steps={driver.setupGuide} hasSecret={ready} />
      )}

      {driver && !plan && driver.secretFields.length > 0 && (
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
              <Tag tone={integration.hasSecret ? 'ok' : 'warn'}>
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
              {testConnectionButton}
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

      {driver?.capabilities.kind !== 'security' && (
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
              {syncableResources.length} of {integration.resources.length}{' '}
              resource{integration.resources.length === 1 ? '' : 's'} ready ·{' '}
              {totalFieldMappings} field mapping
              {totalFieldMappings === 1 ? '' : 's'}
            </span>
          </div>
          <p style={runHelpStyle}>
            Trigger a one-off run across every enabled organization mapping.
            Use <strong>Dry run</strong> to preview record counts and
            conflicts without writing changes; <strong>Run sync now</strong>{' '}
            persists results.
          </p>
          {syncBlockedReason && <Tag tone="warn">{syncBlockedReason}</Tag>}
          {syncHoldCount > 0 && (
            <Checkbox
              label={`Accept changes from ${driver?.label ?? integration.driver}`}
              hint="Applies to Run sync now, which then runs a full sync. Records missing from two full syncs are archived, pages held for a field the source stopped sending are written, and the field check starts again from this sync."
              checked={acceptChanges}
              onChange={setAcceptChanges}
              disabled={cannotSync || syncing}
            />
          )}
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
      )}

      {error && <Tag tone="danger">{error}</Tag>}
      {dirty && plan?.blocked && <Tag tone="warn">{plan.blocked}</Tag>}

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
          disabled={!dirty || Boolean(plan?.blocked)}
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
