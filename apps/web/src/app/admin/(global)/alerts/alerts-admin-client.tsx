'use client';

import { useState } from 'react';
import {
  ALERT_TYPE_DESCRIPTIONS,
  ALERT_TYPE_LABELS,
  alertTypeValues,
  expirationKindValues,
  recordActionValues,
  recordEntityTypeValues,
  type AlertConfig,
  type AlertExpirationKind,
  type AlertRecordAction,
  type AlertRecordEntityType,
  type AlertType,
} from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  CompanyPicker,
  type CompanyPickerValue,
  Dialog,
  Field,
  Input,
  Select,
  Tag,
  useToast,
} from '../../../../components/ui';

/**
 * Single client component owning the list + create/edit dialog.
 *
 * Local state holds the full list; mutations re-issue `GET /alerts`
 * on success so the table reflects authoritative DB ordering. The
 * dialog is disjoint per type — each type renders only the inputs it
 * actually uses, and the save payload is filtered server-side too so
 * cross-type leftovers never persist.
 */
export function AlertsAdminClient({
  initialAlerts,
}: {
  initialAlerts: AlertConfig[];
}) {
  const toast = useToast();
  const [alerts, setAlerts] = useState<AlertConfig[]>(initialAlerts);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    const res = await apiFetch<AlertConfig[]>('/alerts');
    if (res.ok && res.data) setAlerts(res.data);
  }

  async function toggleEnabled(alert: AlertConfig) {
    setBusyId(alert.id);
    const res = await apiFetch<AlertConfig>(`/alerts/${alert.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !alert.enabled }),
    });
    setBusyId(null);
    if (!res.ok || !res.data) {
      toast.push(problemText(res.problem, 'Could not update alert.'), 'danger');
      return;
    }
    await refresh();
  }

  async function archive(alert: AlertConfig) {
    if (!confirm(`Archive alert "${alert.name}"? It will stop firing immediately.`))
      return;
    setBusyId(alert.id);
    const res = await apiFetch(`/alerts/${alert.id}`, { method: 'DELETE' });
    setBusyId(null);
    if (!res.ok) {
      toast.push(problemText(res.problem, 'Could not archive alert.'), 'danger');
      return;
    }
    toast.push('Alert archived.', 'ok');
    await refresh();
  }

  async function sendTest(alert: AlertConfig) {
    setBusyId(alert.id);
    const res = await apiFetch<{ ok: true }>(`/alerts/${alert.id}/test`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setBusyId(null);
    if (!res.ok) {
      toast.push(problemText(res.problem, 'Test email failed.'), 'danger');
      return;
    }
    toast.push(
      `Test email sent to ${alert.recipientEmails.join(', ')}.`,
      'ok',
    );
  }

  return (
    <div>
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ flex: 1, fontSize: 13, color: 'var(--muted)' }}>
          {alerts.length === 0
            ? 'No alerts yet — add one to start receiving notifications.'
            : `${alerts.length} alert${alerts.length === 1 ? '' : 's'} configured.`}
        </span>
        <Btn
          kind="primary"
          onClick={() =>
            setEditing({ mode: 'create', draft: emptyDraft(), error: null })
          }
        >
          New alert
        </Btn>
      </div>

      {alerts.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
          No alerts configured.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr
              style={{
                textAlign: 'left',
                fontSize: 12,
                color: 'var(--muted)',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <th style={th}>Name</th>
              <th style={th}>Type</th>
              <th style={th}>Recipient</th>
              <th style={th}>Status</th>
              <th style={{ ...th, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr
                key={a.id}
                style={{ borderBottom: '1px solid var(--line)' }}
              >
                <td style={td}>
                  <div style={{ fontWeight: 500 }}>{a.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {summariseConfig(a)}
                  </div>
                </td>
                <td style={td}>
                  <Tag tone="default">{ALERT_TYPE_LABELS[a.type]}</Tag>
                </td>
                <td style={td}>
                  {a.recipientEmails.length <= 1 ? (
                    a.recipientEmails[0] ?? '—'
                  ) : (
                    <span title={a.recipientEmails.join(', ')}>
                      {a.recipientEmails[0]}{' '}
                      <span style={{ color: 'var(--muted)' }}>
                        +{a.recipientEmails.length - 1}
                      </span>
                    </span>
                  )}
                </td>
                <td style={td}>
                  <Tag tone={a.enabled ? 'ok' : 'default'}>
                    {a.enabled ? 'Enabled' : 'Disabled'}
                  </Tag>
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
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
                      disabled={busyId === a.id}
                      onClick={() => toggleEnabled(a)}
                    >
                      {a.enabled ? 'Disable' : 'Enable'}
                    </Btn>
                    <Btn
                      kind="ghost"
                      disabled={busyId === a.id}
                      onClick={() => sendTest(a)}
                    >
                      Test
                    </Btn>
                    <Btn
                      kind="ghost"
                      onClick={() =>
                        setEditing({
                          mode: 'edit',
                          id: a.id,
                          draft: toDraft(a),
                          error: null,
                        })
                      }
                    >
                      Edit
                    </Btn>
                    <Btn
                      kind="ghost"
                      disabled={busyId === a.id}
                      onClick={() => archive(a)}
                    >
                      Archive
                    </Btn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <AlertDialog
          state={editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Dialog
// ────────────────────────────────────────────────────────────────────

interface DraftState {
  name: string;
  type: AlertType;
  enabled: boolean;
  /** Free-form text — split on commas/semicolons/newlines on save. */
  recipientEmails: string;
  company: CompanyPickerValue | null;
  triggerDays: string;
  stopAfterTrigger: boolean;
  expirationKinds: AlertExpirationKind[];
  recordEntityTypes: AlertRecordEntityType[];
  recordActions: AlertRecordAction[];
}

type EditState =
  | { mode: 'create'; draft: DraftState; error: string | null }
  | {
      mode: 'edit';
      id: string;
      draft: DraftState;
      error: string | null;
    };

function AlertDialog({
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

  async function save() {
    setError(null);
    setPending(true);
    const payload = toPayload(draft);
    const path =
      state.mode === 'create' ? '/alerts' : `/alerts/${state.id}`;
    const method = state.mode === 'create' ? 'POST' : 'PATCH';
    const res = await apiFetch<AlertConfig>(path, {
      method,
      body: JSON.stringify(payload),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      setError(problemText(res.problem, 'Could not save alert.'));
      return;
    }
    await onSaved();
  }

  const expirationLike =
    draft.type === 'SINGLE_EXPIRATION' || draft.type === 'EXPIRATION_LIST';

  return (
    <Dialog
      open
      onClose={onCancel}
      width={520}
      title={state.mode === 'create' ? 'New alert' : 'Edit alert'}
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
            placeholder="e.g. Domain registrar expirations"
            autoFocus
          />
        </Field>

        <Field
          label="Type"
          help={ALERT_TYPE_DESCRIPTIONS[draft.type]}
        >
          <Select
            value={draft.type}
            onChange={(e) => update('type', e.target.value as AlertType)}
          >
            {alertTypeValues.map((t) => (
              <option key={t} value={t}>
                {ALERT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Send to email"
          help="One or more recipients — separate with commas, semicolons, or new lines."
        >
          <Input
            value={draft.recipientEmails}
            onChange={(e) => update('recipientEmails', e.target.value)}
            placeholder="alerts@example.com, ops@example.com"
          />
        </Field>

        <Field
          label="Company scope"
          help="Leave empty to apply across every company."
        >
          <CompanyPicker
            value={draft.company}
            onChange={(next) => update('company', next)}
            placeholder="All companies"
          />
        </Field>

        {expirationLike && (
          <>
            <Field
              label="Trigger days before expiry"
              help={
                draft.type === 'SINGLE_EXPIRATION'
                  ? 'Fire when an item enters this window.'
                  : 'Include items expiring within this many days in the daily digest.'
              }
            >
              <Input
                type="number"
                min={1}
                max={365}
                value={draft.triggerDays}
                onChange={(e) => update('triggerDays', e.target.value)}
                placeholder="30"
              />
            </Field>
            <Field
              label="Expiration types"
              help="Pick one or more sources of expiration."
            >
              <CheckGroup
                values={expirationKindValues as readonly AlertExpirationKind[]}
                selected={draft.expirationKinds}
                labels={{
                  asset: 'Asset expiry fields',
                  domain_registrar: 'Domain registrar (WHOIS)',
                  domain_tls: 'TLS certificate',
                  password: 'Password expiry',
                  all: 'All of the above',
                }}
                onChange={(next) => update('expirationKinds', next)}
              />
            </Field>
            <Checkbox
              label="Stop alerting after the first trigger per item"
              checked={draft.stopAfterTrigger}
              onChange={(v) => update('stopAfterTrigger', v)}
              hint="Recommended — prevents repeat emails for the same expiring item."
            />
          </>
        )}

        {draft.type === 'RECORD_EVENT' && (
          <>
            <Field label="Alert for record types">
              <CheckGroup
                values={recordEntityTypeValues as readonly AlertRecordEntityType[]}
                selected={draft.recordEntityTypes}
                labels={{
                  asset: 'Assets',
                  article: 'Articles',
                  password: 'Passwords',
                  domain: 'Domains',
                  all: 'All record types',
                }}
                onChange={(next) => update('recordEntityTypes', next)}
              />
            </Field>
            <Field label="When the record is">
              <CheckGroup
                values={recordActionValues as readonly AlertRecordAction[]}
                selected={draft.recordActions}
                labels={{
                  created: 'Created',
                  updated: 'Updated',
                  deleted: 'Deleted (or archived)',
                  all: 'Any change',
                }}
                onChange={(next) => update('recordActions', next)}
              />
            </Field>
          </>
        )}

        {draft.type === 'PASSWORD_EVENT' && (
          <Field label="Password event">
            <CheckGroup
              values={['created', 'updated'] as const}
              selected={
                draft.recordActions.filter(
                  (a) => a === 'created' || a === 'updated',
                ) as AlertRecordAction[]
              }
              labels={{
                created: 'Password created',
                updated: 'Password updated',
              }}
              onChange={(next) => update('recordActions', next)}
            />
          </Field>
        )}

        <Checkbox
          label="Enabled"
          checked={draft.enabled}
          onChange={(v) => update('enabled', v)}
          hint="Disabled alerts stay configured but never fire."
        />

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

// ────────────────────────────────────────────────────────────────────
// Small bits
// ────────────────────────────────────────────────────────────────────

function CheckGroup<T extends string>({
  values,
  selected,
  labels,
  onChange,
}: {
  values: readonly T[];
  selected: T[];
  labels: Partial<Record<T, string>>;
  onChange: (next: T[]) => void;
}) {
  const set = new Set(selected);
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {values.map((v) => (
        <Checkbox
          key={v}
          label={labels[v] ?? v}
          checked={set.has(v)}
          onChange={(checked) => {
            const next = new Set(set);
            if (checked) next.add(v);
            else next.delete(v);
            onChange(Array.from(next));
          }}
        />
      ))}
    </div>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  hint?: string;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        fontSize: 13,
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3 }}
      />
      <span style={{ flex: 1 }}>
        {label}
        {hint && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {hint}
          </div>
        )}
      </span>
    </label>
  );
}

const th = {
  padding: '10px 16px',
  fontWeight: 500,
} as const;

const td = {
  padding: '10px 16px',
  fontSize: 13,
  verticalAlign: 'top' as const,
};

function emptyDraft(): DraftState {
  return {
    name: '',
    type: 'SINGLE_EXPIRATION',
    enabled: true,
    recipientEmails: '',
    company: null,
    triggerDays: '30',
    stopAfterTrigger: true,
    expirationKinds: ['domain_registrar', 'domain_tls'],
    recordEntityTypes: ['all'],
    recordActions: ['all'],
  };
}

function toDraft(a: AlertConfig): DraftState {
  return {
    name: a.name,
    type: a.type,
    enabled: a.enabled,
    recipientEmails: a.recipientEmails.join(', '),
    company: a.companyId
      ? { id: a.companyId, name: a.companyId, slug: '', archivedAt: null }
      : null,
    triggerDays: a.triggerDays != null ? String(a.triggerDays) : '',
    stopAfterTrigger: a.stopAfterTrigger,
    expirationKinds: a.expirationKinds,
    recordEntityTypes:
      a.recordEntityTypes.length > 0 ? a.recordEntityTypes : ['all'],
    recordActions: a.recordActions.length > 0 ? a.recordActions : ['all'],
  };
}

function toPayload(draft: DraftState) {
  const base: Record<string, unknown> = {
    name: draft.name,
    type: draft.type,
    enabled: draft.enabled,
    // Server splits & validates — pass through the raw string so any
    // formatting issue surfaces with the same per-email Zod error.
    recipientEmails: draft.recipientEmails,
    companyId: draft.company?.id ?? null,
    triggerDays: draft.triggerDays
      ? Number(draft.triggerDays)
      : null,
    stopAfterTrigger: draft.stopAfterTrigger,
    expirationKinds: draft.expirationKinds,
    recordEntityTypes: draft.recordEntityTypes,
    recordActions: draft.recordActions,
  };
  return base;
}

function summariseConfig(a: AlertConfig): string {
  switch (a.type) {
    case 'SINGLE_EXPIRATION':
    case 'EXPIRATION_LIST': {
      const kinds = a.expirationKinds.includes('all')
        ? 'all sources'
        : a.expirationKinds.join(', ');
      return `${a.triggerDays ?? '?'} day(s) before — ${kinds}`;
    }
    case 'WEBSITE_DOWN':
      return a.companyId ? 'scoped to one company' : 'all companies';
    case 'RECORD_EVENT': {
      const kinds = a.recordEntityTypes.includes('all')
        ? 'any record'
        : a.recordEntityTypes.join(', ');
      const actions = a.recordActions.includes('all')
        ? 'any change'
        : a.recordActions.join(', ');
      return `${kinds} → ${actions}`;
    }
    case 'PASSWORD_EVENT':
      return a.recordActions.includes('all')
        ? 'created or updated'
        : a.recordActions.join(', ');
    default:
      return '';
  }
}

function problemText(problem: unknown, fallback: string): string {
  if (problem && typeof problem === 'object') {
    const p = problem as { title?: unknown; detail?: unknown };
    if (typeof p.detail === 'string') return p.detail;
    if (typeof p.title === 'string') return p.title;
  }
  return fallback;
}
