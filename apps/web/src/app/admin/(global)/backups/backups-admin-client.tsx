'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  BackupConfig,
  BackupConfigInput,
  BackupRunDto,
  BackupRunStatus,
} from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { FormattedDateTime } from '../../../../lib/timezone-context';
import { downloadWithStepUp } from '../../../../lib/step-up';
import {
  Btn,
  Checkbox,
  DataTable,
  Dialog,
  Field,
  Icon,
  Input,
  MobileCardRow,
  Select,
  Tag,
  useToast,
  type DataColumn,
  type TagTone,
} from '../../../../components/ui';

type Tab = 'schedules' | 'history';

const STATUS_LABELS: Record<BackupRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
};

const STATUS_TONES: Record<BackupRunStatus, TagTone> = {
  queued: 'default',
  running: 'default',
  success: 'ok',
  failed: 'danger',
};

const CRON_PRESETS: Array<{
  id: string;
  label: string;
  cron: string;
  description: string;
}> = [
  {
    id: 'daily-3am',
    label: 'Daily at 03:00',
    cron: '0 3 * * *',
    description: 'Every day at 3:00 AM in the configured timezone.',
  },
  {
    id: 'weekly-sun-3am',
    label: 'Weekly (Sun 03:00)',
    cron: '0 3 * * 0',
    description: 'Once a week on Sunday at 3:00 AM.',
  },
  {
    id: 'monthly-1st-3am',
    label: 'Monthly (1st 03:00)',
    cron: '0 3 1 * *',
    description: 'On the first of every month at 3:00 AM.',
  },
];

const TERMINAL_STATUSES = new Set<BackupRunStatus>(['success', 'failed']);

export function BackupsAdminClient({
  initialConfigs,
  initialRuns,
}: {
  initialConfigs: BackupConfig[];
  initialRuns: BackupRunDto[];
}) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('schedules');
  const [configs, setConfigs] = useState<BackupConfig[]>(initialConfigs);
  const [runs, setRuns] = useState<BackupRunDto[]>(initialRuns);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pollingRunId, setPollingRunId] = useState<string | null>(null);

  const refreshConfigs = async () => {
    const res = await apiFetch<BackupConfig[]>('/backups/configs');
    if (res.ok && res.data) setConfigs(res.data);
  };
  const refreshRuns = async () => {
    const res = await apiFetch<BackupRunDto[]>('/backups/runs?limit=50');
    if (res.ok && res.data) setRuns(res.data);
  };

  // Soft auto-refresh while a run is being polled or while any row is
  // mid-flight. Stops as soon as everything is terminal so the page
  // doesn't hammer the api at idle.
  useEffect(() => {
    const pending = runs.some((r) => !TERMINAL_STATUSES.has(r.status));
    if (!pollingRunId && !pending) return undefined;
    const id = setInterval(() => {
      void refreshRuns();
      if (pollingRunId) {
        void apiFetch<BackupRunDto>(`/backups/runs/${pollingRunId}`).then(
          (res) => {
            if (res.ok && res.data && TERMINAL_STATUSES.has(res.data.status)) {
              setPollingRunId(null);
              if (res.data.status === 'success') {
                toast.push('Backup completed.', 'ok');
              } else {
                toast.push(
                  `Backup failed: ${res.data.error ?? 'unknown error'}`,
                  'danger',
                );
              }
            }
          },
        );
      }
    }, 4000);
    return () => clearInterval(id);
  }, [pollingRunId, runs, toast]);

  async function runNow(cfg: BackupConfig) {
    setBusyId(cfg.id);
    const res = await apiFetch<BackupRunDto>(
      `/backups/configs/${cfg.id}/run-now`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    setBusyId(null);
    if (!res.ok || !res.data) {
      toast.push(
        problemText(res.problem, 'Could not enqueue a backup run.'),
        'danger',
      );
      return;
    }
    toast.push('Backup enqueued. Watch the History tab for progress.', 'ok');
    setPollingRunId(res.data.id);
    setTab('history');
    await refreshRuns();
  }

  async function deleteConfig(cfg: BackupConfig) {
    if (
      !confirm(
        `Delete schedule "${cfg.name}"? Existing dump files on disk are kept; the schedule simply stops firing.`,
      )
    ) {
      return;
    }
    setBusyId(cfg.id);
    const res = await apiFetch(`/backups/configs/${cfg.id}`, {
      method: 'DELETE',
    });
    setBusyId(null);
    if (!res.ok) {
      toast.push(problemText(res.problem, 'Could not delete schedule.'), 'danger');
      return;
    }
    toast.push('Schedule removed.', 'ok');
    await refreshConfigs();
  }

  return (
    <div>
      <div
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          gap: 4,
        }}
      >
        <TabButton active={tab === 'schedules'} onClick={() => setTab('schedules')}>
          Schedules
        </TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
          History
        </TabButton>
        <span style={{ flex: 1 }} />
        {tab === 'schedules' && (
          <Btn
            kind="primary"
            icon={Icon.plus}
            onClick={() =>
              setEditing({
                mode: 'create',
                draft: emptyDraft(),
                error: null,
              })
            }
          >
            New schedule
          </Btn>
        )}
        {tab === 'history' && (
          <Btn kind="ghost" icon={Icon.refresh} onClick={() => void refreshRuns()}>
            Refresh
          </Btn>
        )}
      </div>

      {tab === 'schedules' ? (
        <SchedulesTab
          configs={configs}
          busyId={busyId}
          runNow={runNow}
          deleteConfig={deleteConfig}
          onEdit={(cfg) =>
            setEditing({
              mode: 'edit',
              id: cfg.id,
              draft: toDraft(cfg),
              error: null,
            })
          }
        />
      ) : (
        <HistoryTab runs={runs} />
      )}

      {editing && (
        <ScheduleDialog
          state={editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refreshConfigs();
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Schedules tab
// ─────────────────────────────────────────────────────────────────────

function SchedulesTab({
  configs,
  busyId,
  runNow,
  deleteConfig,
  onEdit,
}: {
  configs: BackupConfig[];
  busyId: string | null;
  runNow: (cfg: BackupConfig) => Promise<void>;
  deleteConfig: (cfg: BackupConfig) => Promise<void>;
  onEdit: (cfg: BackupConfig) => void;
}) {
  if (configs.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
        No schedules yet. Add one to start producing scheduled Postgres
        exports under <code>${'{DATA_DIR}/backup'}</code> on the host.
      </div>
    );
  }

  const columns: DataColumn<BackupConfig>[] = [
    {
      id: 'name',
      header: 'Name',
      width: 240,
      sortValue: (c) => c.name.toLowerCase(),
      render: (c) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontWeight: 500, color: 'var(--text)' }}>{c.name}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {summariseRetention(c)}
          </span>
        </div>
      ),
    },
    {
      id: 'cron',
      header: 'Cron',
      width: 160,
      mono: true,
      render: (c) => (
        <span style={{ color: 'var(--text-2)' }} title={c.timezone ?? 'Etc/UTC'}>
          {c.cron}
        </span>
      ),
    },
    {
      id: 'timezone',
      header: 'Timezone',
      width: 160,
      render: (c) => c.timezone ?? 'Etc/UTC',
    },
    {
      id: 'recipients',
      header: 'Notify',
      width: 200,
      render: (c) =>
        c.notifyEmails.length === 0 ? (
          <span style={{ color: 'var(--muted)' }}>—</span>
        ) : c.notifyEmails.length === 1 ? (
          c.notifyEmails[0]
        ) : (
          <span title={c.notifyEmails.join(', ')}>
            {c.notifyEmails[0]}{' '}
            <span style={{ color: 'var(--muted)' }}>
              +{c.notifyEmails.length - 1}
            </span>
          </span>
        ),
    },
    {
      id: 'lastRun',
      header: 'Last run',
      width: 150,
      sortValue: (c) => c.lastRunAt ?? '',
      render: (c) =>
        c.lastRunAt ? (
          <span title={c.lastRunAt}>
            <FormattedDateTime value={c.lastRunAt} />
          </span>
        ) : (
          <span style={{ color: 'var(--muted)' }}>Never</span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 90,
      render: (c) => (
        <Tag tone={c.enabled ? 'ok' : 'default'}>
          {c.enabled ? 'Enabled' : 'Disabled'}
        </Tag>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      width: 280,
      align: 'right',
      sortable: false,
      render: (c) => (
        <div
          style={{
            display: 'inline-flex',
            gap: 6,
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}
        >
          <Btn
            kind="ghost"
            icon={Icon.zap}
            disabled={busyId === c.id || !c.enabled}
            onClick={() => void runNow(c)}
          >
            Run now
          </Btn>
          <Btn kind="ghost" icon={Icon.edit} onClick={() => onEdit(c)}>
            Edit
          </Btn>
          <Btn
            kind="ghost"
            icon={Icon.trash}
            disabled={busyId === c.id}
            onClick={() => void deleteConfig(c)}
          >
            Delete
          </Btn>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={configs}
      renderMobileCard={(c) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ color: 'var(--text)' }}>{c.name}</strong>
            <Tag tone={c.enabled ? 'ok' : 'default'}>
              {c.enabled ? 'Enabled' : 'Disabled'}
            </Tag>
          </div>
          <MobileCardRow label="Cron">
            <code style={{ fontSize: 12 }}>{c.cron}</code>{' '}
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              · {c.timezone ?? 'Etc/UTC'}
            </span>
          </MobileCardRow>
          <MobileCardRow label="Retention">
            <span style={{ fontSize: 12 }}>{summariseRetention(c)}</span>
          </MobileCardRow>
          <MobileCardRow label="Last run">
            {c.lastRunAt ? <FormattedDateTime value={c.lastRunAt} /> : 'Never'}
          </MobileCardRow>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              borderTop: '1px solid var(--line)',
              paddingTop: 8,
            }}
          >
            <Btn
              kind="outline"
              size="sm"
              disabled={busyId === c.id || !c.enabled}
              onClick={() => void runNow(c)}
            >
              Run now
            </Btn>
            <Btn kind="outline" size="sm" onClick={() => onEdit(c)}>
              Edit
            </Btn>
            <Btn
              kind="outline"
              size="sm"
              disabled={busyId === c.id}
              onClick={() => void deleteConfig(c)}
              style={{ marginLeft: 'auto' }}
            >
              Delete
            </Btn>
          </div>
        </div>
      )}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// History tab
// ─────────────────────────────────────────────────────────────────────

function HistoryTab({ runs }: { runs: BackupRunDto[] }) {
  if (runs.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
        No backup runs yet.
      </div>
    );
  }

  const columns: DataColumn<BackupRunDto>[] = [
    {
      id: 'when',
      header: 'When',
      width: 200,
      sortValue: (r) => r.createdAt,
      render: (r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: 'var(--text)' }}>
            <FormattedDateTime value={r.startedAt ?? r.createdAt} />
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {r.kind === 'MANUAL' ? 'Manual run' : 'Scheduled run'}
          </span>
        </div>
      ),
    },
    {
      id: 'config',
      header: 'Schedule',
      width: 200,
      render: (r) => r.configName ?? <span style={{ color: 'var(--muted)' }}>—</span>,
    },
    {
      id: 'status',
      header: 'Status',
      width: 110,
      render: (r) => (
        <Tag tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</Tag>
      ),
    },
    {
      id: 'size',
      header: 'Size',
      width: 110,
      render: (r) => (r.sizeBytes != null ? formatBytes(r.sizeBytes) : '—'),
    },
    {
      id: 'duration',
      header: 'Duration',
      width: 110,
      render: (r) => formatDuration(r.startedAt, r.finishedAt),
    },
    {
      id: 'actions',
      header: 'Actions',
      width: 230,
      align: 'right',
      sortable: false,
      render: (r) => (
        <div
          style={{
            display: 'inline-flex',
            gap: 6,
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          {r.status === 'success' && r.dumpFilename && (
            <Btn
              kind="ghost"
              icon={Icon.box}
              onClick={() =>
                void downloadWithStepUp(
                  `/api/v1/backups/runs/${r.id}/download`,
                  r.dumpFilename ?? undefined,
                )
              }
            >
              Download
            </Btn>
          )}
          {r.manifest != null && <ManifestButton run={r} />}
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={runs}
      renderMobileCard={(r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Tag tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</Tag>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {r.kind === 'MANUAL' ? 'Manual' : 'Scheduled'}
            </span>
          </div>
          <MobileCardRow label="Started">
            <FormattedDateTime value={r.startedAt ?? r.createdAt} />
          </MobileCardRow>
          <MobileCardRow label="Schedule">{r.configName ?? '—'}</MobileCardRow>
          <MobileCardRow label="Size">
            {r.sizeBytes != null ? formatBytes(r.sizeBytes) : '—'}
          </MobileCardRow>
          {r.error && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--danger)',
                background: 'var(--danger-bg)',
                border: '1px solid var(--danger-line)',
                padding: '6px 8px',
                borderRadius: 4,
              }}
            >
              {r.error}
            </div>
          )}
          {r.status === 'success' && r.dumpFilename && (
            <Btn
              kind="outline"
              size="sm"
              icon={Icon.box}
              onClick={() =>
                void downloadWithStepUp(
                  `/api/v1/backups/runs/${r.id}/download`,
                  r.dumpFilename ?? undefined,
                )
              }
            >
              Download dump
            </Btn>
          )}
        </div>
      )}
    />
  );
}

function ManifestButton({ run }: { run: BackupRunDto }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(
    () => JSON.stringify(run.manifest ?? {}, null, 2),
    [run.manifest],
  );
  return (
    <>
      <Btn kind="ghost" icon={Icon.doc} onClick={() => setOpen(true)}>
        Manifest
      </Btn>
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          width={520}
          title={`Manifest — ${run.dumpFilename ?? run.id}`}
          footer={
            <Btn kind="primary" onClick={() => setOpen(false)}>
              Close
            </Btn>
          }
        >
          <pre
            style={{
              fontSize: 12,
              padding: 12,
              background: 'var(--panel-2)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              overflow: 'auto',
              maxHeight: 360,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {text}
          </pre>
        </Dialog>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Schedule editor
// ─────────────────────────────────────────────────────────────────────

interface DraftState {
  name: string;
  enabled: boolean;
  cronPreset: string;
  cron: string;
  timezone: string;
  retention: { keepLast: string; daily: string; weekly: string; monthly: string };
  notifyEmails: string;
  notifyOnSuccess: boolean;
}

type EditState =
  | { mode: 'create'; draft: DraftState; error: string | null }
  | { mode: 'edit'; id: string; draft: DraftState; error: string | null };

function ScheduleDialog({
  state,
  onCancel,
  onSaved,
}: {
  state: EditState;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftState>(state.draft);
  const [error, setError] = useState<string | null>(state.error);
  const [pending, setPending] = useState(false);

  function update<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function selectPreset(id: string) {
    const preset = CRON_PRESETS.find((p) => p.id === id);
    if (preset) {
      setDraft((prev) => ({
        ...prev,
        cronPreset: id,
        cron: preset.cron,
      }));
    } else {
      setDraft((prev) => ({ ...prev, cronPreset: 'custom' }));
    }
  }

  async function save() {
    setError(null);
    setPending(true);
    const payload = toPayload(draft);
    const path =
      state.mode === 'create'
        ? '/backups/configs'
        : `/backups/configs/${state.id}`;
    const res = await apiFetch<BackupConfig>(path, {
      method: state.mode === 'create' ? 'POST' : 'PATCH',
      body: JSON.stringify(payload),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      setError(problemText(res.problem, 'Could not save schedule.'));
      return;
    }
    await onSaved();
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      width={560}
      title={state.mode === 'create' ? 'New backup schedule' : 'Edit backup schedule'}
      footer={
        <>
          <Btn kind="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Btn>
          <Btn kind="primary" onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <Field label="Name">
          <Input
            value={draft.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder="e.g. Nightly database export"
            autoFocus
          />
        </Field>

        <Field label="Cron preset">
          <Select
            value={draft.cronPreset}
            onChange={(e) => selectPreset(e.target.value)}
          >
            {CRON_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </Select>
        </Field>

        <Field
          label="Cron pattern"
          help="Five-field pattern: minute hour day-of-month month day-of-week."
        >
          <Input
            value={draft.cron}
            onChange={(e) => {
              update('cron', e.target.value);
              update('cronPreset', 'custom');
            }}
            placeholder="0 3 * * *"
          />
        </Field>

        <Field
          label="Timezone"
          help="IANA timezone name (e.g. Etc/UTC, America/New_York). Empty = Etc/UTC."
        >
          <Input
            value={draft.timezone}
            onChange={(e) => update('timezone', e.target.value)}
            placeholder="Etc/UTC"
          />
        </Field>

        <Field
          label="Retention"
          help="`Keep last N` is a floor that always retains the N most-recent successful runs (useful for testing or multiple manual triggers in one day). On top of that, GFS keeps one run per day / week / month for the windows below. The most recent successful run is always kept regardless of these numbers."
        >
          <div
            style={{
              display: 'grid',
              gap: 8,
              gridTemplateColumns: '1fr 1fr 1fr 1fr',
            }}
          >
            <RetentionField
              label="Keep last"
              value={draft.retention.keepLast}
              onChange={(v) =>
                update('retention', { ...draft.retention, keepLast: v })
              }
            />
            <RetentionField
              label="Daily"
              value={draft.retention.daily}
              onChange={(v) => update('retention', { ...draft.retention, daily: v })}
            />
            <RetentionField
              label="Weekly"
              value={draft.retention.weekly}
              onChange={(v) => update('retention', { ...draft.retention, weekly: v })}
            />
            <RetentionField
              label="Monthly"
              value={draft.retention.monthly}
              onChange={(v) => update('retention', { ...draft.retention, monthly: v })}
            />
          </div>
        </Field>

        <Field
          label="Notification recipients"
          help="One or more email addresses — separate with commas, semicolons, or new lines. Leave empty to skip notifications."
        >
          <Input
            value={draft.notifyEmails}
            onChange={(e) => update('notifyEmails', e.target.value)}
            placeholder="ops@example.com, alerts@example.com"
          />
        </Field>

        <Checkbox
          label="Email on success too"
          hint="Off by default — failures still email regardless of this toggle."
          checked={draft.notifyOnSuccess}
          onChange={(v) => update('notifyOnSuccess', v)}
        />

        <Checkbox
          label="Schedule enabled"
          hint="Disabled schedules stay configured but never fire."
          checked={draft.enabled}
          onChange={(v) => update('enabled', v)}
        />

        <div
          style={{
            background: 'var(--panel-2)',
            border: '1px solid var(--line)',
            padding: 10,
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          Dumps land at <code>${'{DATA_DIR}/backup'}</code> on the host. Make
          sure this directory and <code>${'{DATA_DIR}/files'}</code> are part
          of your external backup routine — the in-app schedule covers the
          database only.
        </div>

        {error && (
          <div
            style={{
              padding: '8px 12px',
              background: 'var(--danger-bg)',
              color: 'var(--danger)',
              border: '1px solid var(--danger-line)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function RetentionField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
      <Input
        type="number"
        min={0}
        max={365}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 14px',
        borderRadius: 6,
        border: 'none',
        background: active ? 'var(--panel-2)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--muted)',
        fontSize: 13,
        fontWeight: active ? 500 : 400,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function emptyDraft(): DraftState {
  return {
    name: '',
    enabled: true,
    cronPreset: 'daily-3am',
    cron: '0 3 * * *',
    timezone: 'Etc/UTC',
    retention: { keepLast: '3', daily: '7', weekly: '4', monthly: '12' },
    notifyEmails: '',
    notifyOnSuccess: false,
  };
}

function toDraft(c: BackupConfig): DraftState {
  const matched = CRON_PRESETS.find((p) => p.cron === c.cron);
  return {
    name: c.name,
    enabled: c.enabled,
    cronPreset: matched?.id ?? 'custom',
    cron: c.cron,
    timezone: c.timezone ?? 'Etc/UTC',
    retention: {
      keepLast: String(c.retention.keepLast ?? 3),
      daily: String(c.retention.daily),
      weekly: String(c.retention.weekly),
      monthly: String(c.retention.monthly),
    },
    notifyEmails: c.notifyEmails.join(', '),
    notifyOnSuccess: c.notifyOnSuccess,
  };
}

function toPayload(draft: DraftState): Partial<BackupConfigInput> & {
  retention: {
    keepLast: number;
    daily: number;
    weekly: number;
    monthly: number;
  };
} {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    cron: draft.cron.trim(),
    timezone: draft.timezone.trim() === '' ? null : draft.timezone.trim(),
    retention: {
      keepLast: numberOr(draft.retention.keepLast, 3),
      daily: numberOr(draft.retention.daily, 7),
      weekly: numberOr(draft.retention.weekly, 4),
      monthly: numberOr(draft.retention.monthly, 12),
    },
    notifyEmails: draft.notifyEmails as unknown as string[],
    notifyOnSuccess: draft.notifyOnSuccess,
  };
}

function numberOr(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function summariseRetention(c: BackupConfig): string {
  const parts: string[] = [];
  const keepLast = c.retention.keepLast ?? 0;
  if (keepLast > 0) parts.push(`keep last ${keepLast}`);
  if (c.retention.daily > 0) parts.push(`${c.retention.daily} daily`);
  if (c.retention.weekly > 0) parts.push(`${c.retention.weekly} weekly`);
  if (c.retention.monthly > 0) parts.push(`${c.retention.monthly} monthly`);
  return parts.length === 0 ? 'no retention' : parts.join(' · ');
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '—';
  const ms = Math.max(0, endMs - startMs);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r > 0 ? ` ${r}s` : ''}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(2)} ${units[i]}`;
}

function problemText(problem: unknown, fallback: string): string {
  if (problem && typeof problem === 'object') {
    const p = problem as { title?: unknown; detail?: unknown; message?: unknown };
    if (typeof p.detail === 'string') return p.detail;
    if (typeof p.title === 'string') return p.title;
    if (typeof p.message === 'string') return p.message;
  }
  return fallback;
}
