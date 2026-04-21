'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { MonitoredDomain } from '../../../../../lib/server-api';
import { apiFetch } from '../../../../../lib/api';
import { Dialog, Icon, Tag } from '../../../../../components/ui';
import { useIsMobile } from '../../../../../lib/hooks/use-is-mobile';

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
  const isMobile = useIsMobile();
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
      ) : isMobile ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {rows.map((r) => (
            <li
              key={r.id}
              style={{
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: 12,
                background: 'var(--panel)',
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
                <StatusPill status={r.latestStatus} />
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 6,
                  fontSize: 12,
                }}
              >
                <MobileField label="WHOIS" value={fmtDate(r.whoisExpiresAt)} />
                <MobileField label="TLS" value={fmtDate(r.tlsExpiresAt)} />
                <MobileField
                  label="Visibility"
                  value={r.visibleToClients ? 'Client-visible' : 'Internal'}
                />
                <MobileField label="Last checked" value={fmtRelative(r.lastCheckedAt)} />
              </div>
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
                      <button
                        type="button"
                        onClick={() => runCheck(r.id)}
                        disabled={busyId === r.id || isPending}
                        style={rowButton}
                      >
                        Check
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialog({ kind: 'edit', row: r })}
                        disabled={busyId === r.id || isPending}
                        style={rowButton}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => archive(r.id)}
                        disabled={busyId === r.id || isPending}
                        style={rowButton}
                      >
                        Archive
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => restore(r.id)}
                      disabled={busyId === r.id || isPending}
                      style={rowButton}
                    >
                      Restore
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--dim)' }}>
              <th style={thStyle}>Hostname</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>WHOIS expires</th>
              <th style={thStyle}>TLS expires</th>
              <th style={thStyle}>Visibility</th>
              <th style={thStyle}>Last checked</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                style={{
                  borderTop: '1px solid var(--line)',
                  opacity: r.archivedAt ? 0.6 : 1,
                }}
              >
                <td style={tdStyle}>
                  <Link
                    href={`/admin/companies/${companyId}/domains/${r.id}`}
                    style={{ color: 'var(--text)', fontWeight: 500 }}
                  >
                    {r.hostname}
                  </Link>
                  {r.archivedAt && (
                    <Tag tone="outline" style={{ marginLeft: 8 }}>
                      archived
                    </Tag>
                  )}
                </td>
                <td style={tdStyle}>
                  <StatusPill status={r.latestStatus} />
                </td>
                <td style={monoCell}>{fmtDate(r.whoisExpiresAt)}</td>
                <td style={monoCell}>{fmtDate(r.tlsExpiresAt)}</td>
                <td style={tdStyle}>
                  {r.visibleToClients ? (
                    <Tag tone="accent">client-visible</Tag>
                  ) : (
                    <Tag tone="outline">internal</Tag>
                  )}
                </td>
                <td style={monoCell}>{fmtRelative(r.lastCheckedAt)}</td>
                <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {canManage && !r.archivedAt && (
                    <>
                      <button
                        type="button"
                        onClick={() => runCheck(r.id)}
                        disabled={busyId === r.id || isPending}
                        style={rowButton}
                        title="Run all checks now"
                      >
                        Check
                      </button>
                      <button
                        type="button"
                        onClick={() => setDialog({ kind: 'edit', row: r })}
                        disabled={busyId === r.id || isPending}
                        style={rowButton}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => archive(r.id)}
                        disabled={busyId === r.id || isPending}
                        style={rowButton}
                      >
                        Archive
                      </button>
                    </>
                  )}
                  {canManage && r.archivedAt && (
                    <button
                      type="button"
                      onClick={() => restore(r.id)}
                      disabled={busyId === r.id || isPending}
                      style={rowButton}
                    >
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
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

function MobileField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          color: 'var(--dim)',
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function StatusPill({ status }: { status: MonitoredDomain['latestStatus'] }) {
  const tone = STATUS_TONE[status];
  return <Tag tone={tone.tone}>{tone.label}</Tag>;
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

const thStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  borderBottom: '1px solid var(--line)',
};

const tdStyle: React.CSSProperties = { padding: '12px 14px', verticalAlign: 'middle' };
const monoCell: React.CSSProperties = {
  ...tdStyle,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--muted)',
};

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

const rowButton: React.CSSProperties = {
  marginLeft: 6,
  padding: '4px 10px',
  fontSize: 11.5,
  background: 'var(--panel-2)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  color: 'var(--text)',
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
