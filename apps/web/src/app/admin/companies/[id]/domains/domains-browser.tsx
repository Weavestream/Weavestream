'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { MonitoredDomain } from '../../../../../lib/server-api';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  DataTable,
  type DataColumn,
  Dialog,
  Icon,
  MobileCardRow,
  Tag,
  type TagTone,
} from '../../../../../components/ui';

/**
 * Phase 8 — Admin domains browser.
 *
 * Renders the table and owns the add/edit dialog state. Each mutation
 * calls the REST API and then runs `router.refresh()` so the
 * server-rendered layout re-fetches the list + sidebar badge. We keep
 * the dialog a separate component because the same shape is used for
 * both "Add" (empty initial) and "Edit" (populated from a row).
 */
export function DomainsBrowser({
  companyId,
  rows,
  canManage,
}: {
  companyId: string;
  rows: MonitoredDomain[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<
    | { kind: 'add' }
    | { kind: 'edit'; row: MonitoredDomain }
    | null
  >(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(
    form: FormState,
    mode: 'add' | 'edit',
    id: string | null,
  ) {
    setError(null);
    const body: Record<string, unknown> = {
      hostname: form.hostname.trim(),
      checkWhois: form.checkWhois,
      checkDns: form.checkDns,
      checkTls: form.checkTls,
      alertThresholdDays: form.alertThresholdDays,
      visibleToClients: form.visibleToClients,
      // v2 — DKIM selector override is persisted as a trimmed CSV
      // string (or `null` when empty) so the engine can probe these
      // selectors in addition to the MX-keyed defaults.
      dkimSelectorOverride: form.dkimSelectorOverride.trim() || null,
    };
    const res =
      mode === 'add'
        ? await apiFetch<MonitoredDomain>(`/companies/${companyId}/domains`, {
            method: 'POST',
            body: JSON.stringify(body),
          })
        : await apiFetch<MonitoredDomain>(
            `/companies/${companyId}/domains/${id}`,
            { method: 'PATCH', body: JSON.stringify(body) },
          );
    if (!res.ok) {
      setError(problemMessage(res.problem) ?? 'Save failed');
      return;
    }
    setDialog(null);
    startTransition(() => router.refresh());
  }

  async function runCheck(id: string) {
    setBusyId(id);
    setError(null);
    const res = await apiFetch<unknown>(
      `/companies/${companyId}/domains/${id}/check`,
      { method: 'POST' },
    );
    if (!res.ok) setError(problemMessage(res.problem) ?? 'Check failed');
    setBusyId(null);
    startTransition(() => router.refresh());
  }

  async function archive(id: string) {
    setBusyId(id);
    setError(null);
    const res = await apiFetch<unknown>(
      `/companies/${companyId}/domains/${id}`,
      { method: 'DELETE' },
    );
    if (!res.ok) setError(problemMessage(res.problem) ?? 'Archive failed');
    setBusyId(null);
    startTransition(() => router.refresh());
  }

  async function restore(id: string) {
    setBusyId(id);
    setError(null);
    const res = await apiFetch<unknown>(
      `/companies/${companyId}/domains/${id}/restore`,
      { method: 'POST' },
    );
    if (!res.ok) setError(problemMessage(res.problem) ?? 'Restore failed');
    setBusyId(null);
    startTransition(() => router.refresh());
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          borderBottom: '1px solid var(--line)',
          fontSize: 12,
        }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>
          {rows.length} domain{rows.length === 1 ? '' : 's'}
        </span>
        <div style={{ flex: 1 }} />
        {canManage && (
          <button
            type="button"
            onClick={() => setDialog({ kind: 'add' })}
            style={addButtonStyle}
          >
            <Icon.plus size={12} /> Add domain
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: '8px 14px',
            color: 'var(--danger)',
            fontSize: 12,
            borderBottom: '1px solid var(--line)',
          }}
        >
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div
          style={{
            padding: 48,
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          <div style={{ fontSize: 24, marginBottom: 8 }}>
            <Icon.globe size={24} />
          </div>
          No monitored domains yet.
        </div>
      ) : (
        <DataTable
          columns={domainColumns({
            companyId,
            canManage,
            busyId,
            isPending,
            runCheck,
            archive,
            restore,
            setDialog,
          })}
          rows={rows}
          renderMobileCard={(r) => (
            <div
              style={{
                opacity: r.archivedAt ? 0.6 : 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Link
                  href={`/admin/companies/${companyId}/domains/${r.id}`}
                  style={{
                    color: 'var(--text)',
                    fontWeight: 600,
                    fontSize: 14,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  {r.hostname}
                </Link>
                <ScoreChip score={r.latestScore} />
                <StatusPill status={r.latestStatus} />
              </div>
              <MobileCardRow label="WHOIS" mono>
                {fmtDate(r.whoisExpiresAt)}
              </MobileCardRow>
              <MobileCardRow label="TLS" mono>
                {fmtDate(r.tlsExpiresAt)}
              </MobileCardRow>
              <MobileCardRow label="Visibility">
                {r.visibleToClients ? 'Client-visible' : 'Internal'}
              </MobileCardRow>
              <MobileCardRow label="Checked" mono>
                {fmtRelative(r.lastCheckedAt)}
              </MobileCardRow>
              {r.archivedAt && (
                <Tag tone="outline" style={{ alignSelf: 'flex-start' }}>
                  archived
                </Tag>
              )}
              {canManage && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    borderTop: '1px solid var(--line)',
                    paddingTop: 10,
                  }}
                >
                  {!r.archivedAt ? (
                    <>
                      <Btn
                        kind="ghost"
                        icon={Icon.refresh}
                        disabled={busyId === r.id || isPending}
                        onClick={() => runCheck(r.id)}
                      >
                        Check
                      </Btn>
                      <Btn
                        kind="ghost"
                        icon={Icon.edit}
                        disabled={busyId === r.id || isPending}
                        onClick={() => setDialog({ kind: 'edit', row: r })}
                      >
                        Edit
                      </Btn>
                      <Btn
                        kind="ghost"
                        icon={Icon.archive}
                        disabled={busyId === r.id || isPending}
                        onClick={() => archive(r.id)}
                      >
                        Archive
                      </Btn>
                    </>
                  ) : (
                    <Btn
                      kind="ghost"
                      icon={Icon.refresh}
                      disabled={busyId === r.id || isPending}
                      onClick={() => restore(r.id)}
                    >
                      Restore
                    </Btn>
                  )}
                </div>
              )}
            </div>
          )}
        />
      )}

      {dialog && canManage && (
        <DomainDialog
          initial={dialog.kind === 'edit' ? dialog.row : null}
          onCancel={() => setDialog(null)}
          onSubmit={(form) =>
            submit(
              form,
              dialog.kind,
              dialog.kind === 'edit' ? dialog.row.id : null,
            )
          }
        />
      )}
    </div>
  );
}

export interface FormState {
  hostname: string;
  checkWhois: boolean;
  checkDns: boolean;
  checkTls: boolean;
  alertThresholdDays: number;
  visibleToClients: boolean;
  /** v2 — operator-supplied DKIM selectors (comma-separated). */
  dkimSelectorOverride: string;
}

function DomainDialog({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: MonitoredDomain | null;
  onCancel: () => void;
  onSubmit: (form: FormState) => Promise<void>;
}) {
  const [form, setForm] = useState<FormState>({
    hostname: initial?.hostname ?? '',
    checkWhois: initial?.checkWhois ?? true,
    checkDns: initial?.checkDns ?? true,
    checkTls: initial?.checkTls ?? true,
    alertThresholdDays: initial?.alertThresholdDays ?? 30,
    visibleToClients: initial?.visibleToClients ?? false,
    dkimSelectorOverride: initial?.dkimSelectorOverride ?? '',
  });
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog
      open
      onClose={onCancel}
      title={initial ? 'Edit domain' : 'Add domain'}
      width={480}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSubmitting(true);
          try {
            await onSubmit(form);
          } finally {
            setSubmitting(false);
          }
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 4 }}
      >
        <label style={fieldStyle}>
          <span style={fieldLabel}>Hostname</span>
          <input
            type="text"
            placeholder="example.com"
            required
            value={form.hostname}
            autoFocus
            onChange={(e) => setForm({ ...form, hostname: e.target.value })}
            style={inputStyle}
          />
          <span style={hintStyle}>
            No scheme, path, or port. Use the root domain only.
          </span>
        </label>

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Toggle
            label="WHOIS"
            checked={form.checkWhois}
            onChange={(v) => setForm({ ...form, checkWhois: v })}
          />
          <Toggle
            label="DNS"
            checked={form.checkDns}
            onChange={(v) => setForm({ ...form, checkDns: v })}
          />
          <Toggle
            label="TLS"
            checked={form.checkTls}
            onChange={(v) => setForm({ ...form, checkTls: v })}
          />
        </div>

        <label style={fieldStyle}>
          <span style={fieldLabel}>Alert threshold (days)</span>
          <input
            type="number"
            min={1}
            max={365}
            value={form.alertThresholdDays}
            onChange={(e) =>
              setForm({
                ...form,
                alertThresholdDays: Math.max(1, Math.min(365, Number(e.target.value) || 30)),
              })
            }
            style={{ ...inputStyle, width: 90 }}
          />
          <span style={hintStyle}>
            Flagged EXPIRING when the WHOIS or TLS expiry is within this
            window.
          </span>
        </label>

        <Toggle
          label="Visible to clients"
          checked={form.visibleToClients}
          onChange={(v) => setForm({ ...form, visibleToClients: v })}
          description="Clients on the portal will see this domain's hostname, status, and expiry. Keep off for MSP-internal entries."
        />

        <label style={fieldStyle}>
          <span style={fieldLabel}>DKIM selectors</span>
          <input
            type="text"
            placeholder="e.g. mail2024, selector-prod"
            value={form.dkimSelectorOverride}
            onChange={(e) =>
              setForm({ ...form, dkimSelectorOverride: e.target.value })
            }
            style={inputStyle}
          />
          <span style={hintStyle}>
            Comma-separated. Only needed if your DKIM selectors don&apos;t match
            our defaults (e.g. <code>google</code>, <code>selector1</code>).
          </span>
        </label>


        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} style={secondaryBtn}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || form.hostname.trim().length === 0}
            style={primaryBtn}
          >
            {submitting ? 'Saving…' : initial ? 'Save changes' : 'Add'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: string;
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: description ? 'flex-start' : 'center',
        gap: 8,
        fontSize: 13,
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span>{label}</span>
        {description && (
          <span style={{ color: 'var(--dim)', fontSize: 11.5 }}>
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

function domainColumns({
  companyId,
  canManage,
  busyId,
  isPending,
  runCheck,
  archive,
  restore,
  setDialog,
}: {
  companyId: string;
  canManage: boolean;
  busyId: string | null;
  isPending: boolean;
  runCheck: (id: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  setDialog: (
    s: { kind: 'add' } | { kind: 'edit'; row: MonitoredDomain } | null,
  ) => void;
}): DataColumn<MonitoredDomain>[] {
  const STATUS_RANK: Record<MonitoredDomain['latestStatus'], number> = {
    OK: 0,
    EXPIRING: 1,
    EXPIRED: 2,
    FAIL: 3,
    UNKNOWN: 4,
  };
  const cols: DataColumn<MonitoredDomain>[] = [
    {
      id: 'hostname',
      header: 'Hostname',
      width: 280,
      sortValue: (r) => r.hostname.toLowerCase(),
      render: (r) => (
        <span
          style={{
            opacity: r.archivedAt ? 0.6 : 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Link
            href={`/admin/companies/${companyId}/domains/${r.id}`}
            style={{ color: 'var(--text)', fontWeight: 500 }}
          >
            {r.hostname}
          </Link>
          {r.archivedAt && <Tag tone="outline">archived</Tag>}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 110,
      sortValue: (r) => STATUS_RANK[r.latestStatus],
      render: (r) => <StatusPill status={r.latestStatus} />,
    },
    {
      id: 'score',
      header: 'Score',
      width: 100,
      sortValue: (r) => r.latestScore ?? -1,
      render: (r) => <ScoreChip score={r.latestScore} />,
    },
    {
      id: 'whois',
      header: 'WHOIS expires',
      width: 140,
      mono: true,
      sortValue: (r) => (r.whoisExpiresAt ? new Date(r.whoisExpiresAt) : null),
      render: (r) => (
        <span style={{ color: 'var(--muted)' }}>{fmtDate(r.whoisExpiresAt)}</span>
      ),
    },
    {
      id: 'tls',
      header: 'TLS expires',
      width: 140,
      mono: true,
      sortValue: (r) => (r.tlsExpiresAt ? new Date(r.tlsExpiresAt) : null),
      render: (r) => (
        <span style={{ color: 'var(--muted)' }}>{fmtDate(r.tlsExpiresAt)}</span>
      ),
    },
    {
      id: 'visibility',
      header: 'Visibility',
      width: 140,
      sortValue: (r) => (r.visibleToClients ? 1 : 0),
      render: (r) =>
        r.visibleToClients ? (
          <Tag tone="accent">client-visible</Tag>
        ) : (
          <Tag tone="outline">internal</Tag>
        ),
    },
    {
      id: 'lastChecked',
      header: 'Last checked',
      width: 140,
      mono: true,
      sortValue: (r) => (r.lastCheckedAt ? new Date(r.lastCheckedAt) : null),
      render: (r) => (
        <span style={{ color: 'var(--muted)' }}>{fmtRelative(r.lastCheckedAt)}</span>
      ),
    },
  ];

  if (canManage) {
    cols.push({
      id: 'actions',
      header: 'Actions',
      width: 240,
      align: 'right',
      sortable: false,
      render: (r) => (
        <span
          style={{
            display: 'inline-flex',
            gap: 6,
            justifyContent: 'flex-end',
            whiteSpace: 'nowrap',
          }}
        >
          {!r.archivedAt ? (
            <>
              <Btn
                kind="ghost"
                icon={Icon.refresh}
                disabled={busyId === r.id || isPending}
                onClick={() => runCheck(r.id)}
                title="Run all checks now"
              >
                Check
              </Btn>
              <Btn
                kind="ghost"
                icon={Icon.edit}
                disabled={busyId === r.id || isPending}
                onClick={() => setDialog({ kind: 'edit', row: r })}
              >
                Edit
              </Btn>
              <Btn
                kind="ghost"
                icon={Icon.archive}
                disabled={busyId === r.id || isPending}
                onClick={() => archive(r.id)}
              >
                Archive
              </Btn>
            </>
          ) : (
            <Btn
              kind="ghost"
              icon={Icon.refresh}
              disabled={busyId === r.id || isPending}
              onClick={() => restore(r.id)}
            >
              Restore
            </Btn>
          )}
        </span>
      ),
    });
  }

  return cols;
}

export function StatusPill({ status }: { status: MonitoredDomain['latestStatus'] }) {
  const tone = STATUS_TONE[status];
  return <Tag tone={tone.tone}>{tone.label}</Tag>;
}

function scoreToTone(score: number): TagTone {
  if (score >= 75) return 'ok';
  if (score >= 55) return 'warn';
  return 'danger';
}

function ScoreChip({ score }: { score: number | null }) {
  if (score === null) {
    return <Tag tone="outline">—</Tag>;
  }
  return <Tag tone={scoreToTone(score)}>{score}%</Tag>;
}

const STATUS_TONE: Record<
  MonitoredDomain['latestStatus'],
  { label: string; tone: 'ok' | 'warn' | 'danger' | 'accent' | 'outline' }
> = {
  OK: { label: 'OK', tone: 'ok' },
  EXPIRING: { label: 'Expiring', tone: 'warn' },
  EXPIRED: { label: 'Expired', tone: 'danger' },
  FAIL: { label: 'Fail', tone: 'danger' },
  UNKNOWN: { label: 'Unknown', tone: 'outline' },
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 10);
}

function fmtRelative(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} d ago`;
}

function problemMessage(problem: unknown): string | null {
  if (!problem || typeof problem !== 'object') return null;
  const record = problem as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.detail === 'string') return record.detail;
  return null;
}

const addButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 10px',
  background: 'var(--accent)',
  color: 'var(--accent-ink)',
  borderRadius: 5,
  fontSize: 12,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
};

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const fieldLabel: React.CSSProperties = {
  fontSize: 11.5,
  fontFamily: 'var(--font-mono)',
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.3,
};

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 5,
  padding: '7px 10px',
  fontSize: 13,
  background: 'var(--panel-2)',
  color: 'var(--text)',
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--dim)',
};

const primaryBtn: React.CSSProperties = {
  padding: '7px 14px',
  fontSize: 12.5,
  fontWeight: 600,
  background: 'var(--accent)',
  color: 'var(--accent-ink)',
  border: 'none',
  borderRadius: 5,
  cursor: 'pointer',
};
const secondaryBtn: React.CSSProperties = {
  padding: '7px 14px',
  fontSize: 12.5,
  background: 'transparent',
  color: 'var(--muted)',
  border: '1px solid var(--line)',
  borderRadius: 5,
  cursor: 'pointer',
};
