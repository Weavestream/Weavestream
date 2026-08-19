'use client';

import { useState } from 'react';
import {
  expirationKindValues,
  recordActionValues,
  recordEntityTypeValues,
  type AlertConfig,
  type AlertExpirationKind,
  type AlertRecordAction,
  type AlertRecordEntityType,
} from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  Checkbox,
  CompanyPicker,
  DataTable,
  type DataColumn,
  Dialog,
  ErrorBanner,
  Field,
  Icon,
  Input,
  MobileCardRow,
  Tag,
  useToast,
} from '../../../../components/ui';
import {
  ALERT_CHOICE_CARDS,
  activeChoiceCard,
  alertKindLabel,
  choiceKey,
  emptyDraft,
  payloadRecordActions,
  securitySelectorOfConfig,
  selectAlertChoice,
  type AlertChoice,
  type DraftState,
} from './alert-choice';

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
    // `flex: 1; min-height: 0` so the DataTable's own fillHeight scroll
    // region claims the leftover viewport instead of the whole page
    // scrolling under it — the chain is PageBody -> Panel fillHeight ->
    // here -> DataTable fillHeight.
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      }}
    >
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
        <DataTable
          fillHeight
          columns={alertColumns({ busyId, toggleEnabled, sendTest, archive, setEditing })}
          rows={alerts}
          renderMobileCard={(a) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontWeight: 500, color: 'var(--text)' }}>{a.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {summariseConfig(a)}
              </div>
              <MobileCardRow label="Type">
                <Tag tone="default">{alertKindLabel(a)}</Tag>
              </MobileCardRow>
              <MobileCardRow label="Recipient">
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
              </MobileCardRow>
              <MobileCardRow label="Status">
                <Tag tone={a.enabled ? 'ok' : 'default'}>
                  {a.enabled ? 'Enabled' : 'Disabled'}
                </Tag>
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
                  disabled={busyId === a.id}
                  onClick={() => toggleEnabled(a)}
                >
                  {a.enabled ? 'Disable' : 'Enable'}
                </Btn>
                <Btn
                  kind="outline"
                  size="sm"
                  disabled={busyId === a.id}
                  onClick={() => sendTest(a)}
                >
                  Test
                </Btn>
                <Btn
                  kind="outline"
                  size="sm"
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
                  kind="outline"
                  size="sm"
                  disabled={busyId === a.id}
                  onClick={() => archive(a)}
                  style={{ marginLeft: 'auto' }}
                >
                  Archive
                </Btn>
              </div>
            </div>
          )}
        />
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
  // Two-step wizard: create starts on the type picker, edit jumps
  // straight to the form ("Change type" returns to the picker in both
  // modes).
  const [step, setStep] = useState<'pick' | 'form'>(
    state.mode === 'create' ? 'pick' : 'form',
  );

  function update<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function choose(choice: AlertChoice) {
    setDraft((prev) => selectAlertChoice(prev, choice));
    setStep('form');
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
  const securitySelector = securitySelectorOfConfig(draft);
  const activeCard = activeChoiceCard(draft);

  if (step === 'pick') {
    return (
      <Dialog
        open
        onClose={onCancel}
        width={680}
        title={state.mode === 'create' ? 'New alert' : 'Edit alert'}
        footer={
          <Btn kind="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Btn>
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            What should this alert watch for?
          </span>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 10,
            }}
          >
            {ALERT_CHOICE_CARDS.map((card) => {
              const key = choiceKey(card.choice);
              const selected = activeCard != null && choiceKey(activeCard.choice) === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => choose(card.choice)}
                  style={{
                    textAlign: 'left',
                    padding: '12px 14px',
                    background: 'var(--surface)',
                    border: `1px solid ${selected ? 'var(--accent)' : 'var(--line)'}`,
                    borderRadius: 8,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                    {card.label}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {card.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </Dialog>
    );
  }

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
        <Field label="Type" help={activeCard?.description}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Tag tone="default">{activeCard?.label ?? draft.type}</Tag>
            <Btn kind="ghost" onClick={() => setStep('pick')} disabled={pending}>
              Change type
            </Btn>
          </div>
        </Field>

        <Field label="Name">
          <Input
            value={draft.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder={
              securitySelector
                ? 'e.g. Security: failed sign-ins'
                : 'e.g. Domain registrar expirations'
            }
            autoFocus
          />
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

        {securitySelector === null && (
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
        )}

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

        {draft.type === 'RECORD_EVENT' && securitySelector === null && (
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

        {error && <ErrorBanner title={error} />}
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

function alertColumns({
  busyId,
  toggleEnabled,
  sendTest,
  archive,
  setEditing,
}: {
  busyId: string | null;
  toggleEnabled: (a: AlertConfig) => void;
  sendTest: (a: AlertConfig) => void;
  archive: (a: AlertConfig) => void;
  setEditing: (s: EditState) => void;
}): DataColumn<AlertConfig>[] {
  return [
    {
      id: 'name',
      header: 'Name',
      width: 320,
      sortValue: (a) => a.name.toLowerCase(),
      render: (a) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontWeight: 500, color: 'var(--text)' }}>{a.name}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {summariseConfig(a)}
          </span>
        </div>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      width: 180,
      sortValue: (a) => alertKindLabel(a),
      render: (a) => <Tag tone="default">{alertKindLabel(a)}</Tag>,
    },
    {
      id: 'recipient',
      header: 'Recipient',
      width: 220,
      sortValue: (a) => a.recipientEmails[0]?.toLowerCase() ?? '',
      render: (a) =>
        a.recipientEmails.length <= 1 ? (
          a.recipientEmails[0] ?? '—'
        ) : (
          <span title={a.recipientEmails.join(', ')}>
            {a.recipientEmails[0]}{' '}
            <span style={{ color: 'var(--muted)' }}>
              +{a.recipientEmails.length - 1}
            </span>
          </span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 110,
      sortValue: (a) => (a.enabled ? 1 : 0),
      render: (a) => (
        <Tag tone={a.enabled ? 'ok' : 'default'}>
          {a.enabled ? 'Enabled' : 'Disabled'}
        </Tag>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      width: 320,
      align: 'right',
      sortable: false,
      render: (a) => (
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
            icon={a.enabled ? Icon.x : Icon.check}
            disabled={busyId === a.id}
            onClick={() => toggleEnabled(a)}
          >
            {a.enabled ? 'Disable' : 'Enable'}
          </Btn>
          <Btn
            kind="ghost"
            icon={Icon.bell}
            disabled={busyId === a.id}
            onClick={() => sendTest(a)}
          >
            Test
          </Btn>
          <Btn
            kind="ghost"
            icon={Icon.edit}
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
            icon={Icon.archive}
            disabled={busyId === a.id}
            onClick={() => archive(a)}
          >
            Archive
          </Btn>
        </div>
      ),
    },
  ];
}

function toDraft(a: AlertConfig): DraftState {
  return {
    name: a.name,
    type: a.type,
    enabled: a.enabled,
    recipientEmails: a.recipientEmails.join(', '),
    // Prefer the resolved company ref from the API so the picker shows
    // the real name/slug. Fall back to a UUID-only stub only when the
    // referenced company has been hard-deleted — the picker will still
    // render, just without a friendly label.
    company: a.company
      ? {
          id: a.company.id,
          name: a.company.name,
          slug: a.company.slug,
          archivedAt: a.company.archivedAt,
        }
      : a.companyId
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
    recordActions: payloadRecordActions(draft),
  };
  return base;
}

function summariseConfig(a: AlertConfig): string {
  // Security kinds carry no per-config settings beyond global scope;
  // the type column already names the kind.
  if (securitySelectorOfConfig(a)) return 'security events — all companies';
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
    // RFC 7807 extension members (see ProblemExceptionFilter): the useful
    // per-field message lives in `issues[]`; `detail` is only the stable
    // code "ValidationError" for a ZodBody rejection. Prefer the issue
    // message so e.g. "Too many recipients (max 100)" reaches the user
    // instead of the opaque code. Mirrors `handleApiError` in asset-form.
    const p = problem as {
      title?: unknown;
      detail?: unknown;
      issues?: Array<{ message?: unknown }>;
    };
    if (Array.isArray(p.issues) && typeof p.issues[0]?.message === 'string') {
      return p.issues[0].message;
    }
    if (typeof p.detail === 'string' && p.detail !== 'ValidationError') {
      return p.detail;
    }
    if (typeof p.title === 'string') return p.title;
  }
  return fallback;
}
