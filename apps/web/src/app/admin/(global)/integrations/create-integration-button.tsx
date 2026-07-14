'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  DriverDescriptor,
  DriverFieldDescriptor,
  IntegrationDto,
} from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  Dialog,
  Field,
  Icon,
  Input,
  Select,
  Tag,
  useToast,
} from '../../../../components/ui';
import { DriverFieldsEditor } from './driver-fields-editor';
import { safeIntegrationProblemMessage } from './integration-feedback';

/**
 * Phase 11 — "New integration" button + dialog.
 *
 * The dialog is driver-aware: picking a driver dynamically renders the
 * config + secret fields the driver advertises in `DriverDescriptor`.
 * No driver-specific code lives here — the descriptors carry every
 * label, hint, and required flag.
 */
export function CreateIntegrationButton({
  drivers,
}: {
  drivers: DriverDescriptor[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [driverKey, setDriverKey] = useState<string>(drivers[0]?.key ?? '');
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [secret, setSecret] = useState<Record<string, unknown>>({});
  const [syncCron, setSyncCron] = useState<string>('');

  const driver = useMemo(
    () => drivers.find((d) => d.key === driverKey) ?? null,
    [drivers, driverKey],
  );

  function reset() {
    setDriverKey(drivers[0]?.key ?? '');
    setName('');
    setConfig({});
    setSecret({});
    setSyncCron('');
    setError(null);
  }

  function close() {
    if (pending) return;
    setOpen(false);
    reset();
  }

  const requiredOk = useMemo(() => {
    if (!driver || !name.trim()) return false;
    for (const f of driver.configFields) {
      if (f.required && (config[f.key] === undefined || config[f.key] === '')) {
        return false;
      }
    }
    for (const f of driver.secretFields) {
      if (f.required && (secret[f.key] === undefined || secret[f.key] === '')) {
        return false;
      }
    }
    return true;
  }, [driver, name, config, secret]);

  async function submit() {
    if (!driver) return;
    setError(null);
    setPending(true);
    const body = {
      driver: driver.key,
      name: name.trim(),
      config: stripEmpty(config, driver.configFields),
      ...(Object.keys(secret).length > 0
        ? { secret: stripEmpty(secret, driver.secretFields) }
        : {}),
      ...(syncCron.trim() ? { syncCron: syncCron.trim() } : {}),
      status: 'PAUSED' as const,
    };
    const res = await apiFetch<IntegrationDto>('/admin/integrations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as
        | { detail?: string; title?: string }
        | undefined;
      const message = safeIntegrationProblemMessage(
        problem,
        'Could not create integration.',
        secret,
      );
      setError(message);
      toast.push(message, 'danger');
      return;
    }
    toast.push('Integration created.', 'ok');
    setOpen(false);
    reset();
    router.push(`/admin/integrations/${res.data.id}`);
    router.refresh();
  }

  if (drivers.length === 0) {
    return (
      <Tag tone="warn">No drivers registered — rebuild the API to install drivers.</Tag>
    );
  }

  return (
    <>
      <Btn kind="primary" icon={Icon.plus} onClick={() => setOpen(true)}>
        New integration
      </Btn>
      <Dialog
        open={open}
        onClose={close}
        title="Create integration"
        width={560}
        footer={
          <>
            <Btn kind="ghost" onClick={close} disabled={pending}>
              Cancel
            </Btn>
            <Btn
              kind="primary"
              onClick={submit}
              loading={pending}
              disabled={!requiredOk}
            >
              Create
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Driver" htmlFor="i-driver">
            <Select
              id="i-driver"
              value={driverKey}
              onChange={(e) => {
                setDriverKey(e.target.value);
                setConfig({});
                setSecret({});
              }}
            >
              {drivers.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
          {driver?.description && (
            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                color: 'var(--muted)',
                lineHeight: 1.5,
              }}
            >
              {driver.description}
            </p>
          )}
          <Field
            label="Display name"
            htmlFor="i-name"
            help="Operator-facing label. Pick something specific — you can host more than one of the same driver."
          >
            <Input
              id="i-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={driver ? `${driver.label} (production)` : 'Action1 (production)'}
              maxLength={100}
            />
          </Field>
          {driver && driver.configFields.length > 0 && (
            <DriverFieldsEditor
              title="Configuration"
              fields={driver.configFields}
              values={config}
              onChange={setConfig}
            />
          )}
          {driver && driver.secretFields.length > 0 && (
            <DriverFieldsEditor
              title="Credentials"
              help="Encrypted at rest with the workspace integration key."
              fields={driver.secretFields}
              values={secret}
              onChange={setSecret}
              isSecret
            />
          )}
          <Field
            label="Sync schedule (cron)"
            htmlFor="i-cron"
            help={
              "5-field cron expression in UTC, e.g. '*/15 * * * *'. Leave blank to inherit the global default; administrators can set that default to 'off' to disable scheduled runs."
            }
          >
            <Input
              id="i-cron"
              value={syncCron}
              onChange={(e) => setSyncCron(e.target.value)}
              placeholder="*/15 * * * *"
            />
          </Field>
          {error && <Tag tone="danger">{error}</Tag>}
          <Tag tone="info">
            New integrations start <strong>paused</strong>. Finish setup,
            then activate.
          </Tag>
        </div>
      </Dialog>
    </>
  );
}

function stripEmpty(
  values: Record<string, unknown>,
  fields: DriverFieldDescriptor[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined || v === '' || v === null) continue;
    out[f.key] = v;
  }
  return out;
}
