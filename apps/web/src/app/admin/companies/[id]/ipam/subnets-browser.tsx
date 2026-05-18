'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import type { SubnetRow } from '../../../../../lib/server-api';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  DataTable,
  Dialog,
  Field,
  Icon,
  Input,
  MobileCardRow,
  Tag,
  Textarea,
  type DataColumn,
} from '../../../../../components/ui';

export function SubnetsBrowser({
  companyId,
  rows,
  canManage,
  openNew = false,
}: {
  companyId: string;
  rows: SubnetRow[];
  canManage: boolean;
  openNew?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [dialog, setDialog] = useState<
    { kind: 'add' } | { kind: 'edit'; row: SubnetRow } | null
  >(openNew && canManage ? { kind: 'add' } : null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function closeDialog() {
    setDialog(null);
    setError(null);
    if (searchParams.has('new')) {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.delete('new');
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    }
  }

  useEffect(() => {
    if (openNew && canManage) setDialog({ kind: 'add' });
  }, [openNew, canManage]);

  async function submit(form: SubnetForm, mode: 'add' | 'edit', id: string | null) {
    setError(null);
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      cidr: form.cidr.trim(),
      vlanId: form.vlanId ? Number(form.vlanId) : null,
      gateway: form.gateway?.trim() || null,
      dhcpRangeStart: form.dhcpRangeStart?.trim() || null,
      dhcpRangeEnd: form.dhcpRangeEnd?.trim() || null,
      description: form.description?.trim() || null,
    };
    const res =
      mode === 'add'
        ? await apiFetch(`/companies/${companyId}/ipam/subnets`, {
            method: 'POST',
            body: JSON.stringify(body),
          })
        : await apiFetch(`/companies/${companyId}/ipam/subnets/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
    if (!res.ok) {
      setError(problemMsg(res.problem) ?? 'Save failed');
      return;
    }
    closeDialog();
    startTransition(() => router.refresh());
  }

  async function archive(id: string) {
    setBusyId(id);
    setError(null);
    const res = await apiFetch(`/companies/${companyId}/ipam/subnets/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) setError(problemMsg(res.problem) ?? 'Archive failed');
    setBusyId(null);
    startTransition(() => router.refresh());
  }

  async function restore(id: string) {
    setBusyId(id);
    setError(null);
    const res = await apiFetch(`/companies/${companyId}/ipam/subnets/${id}/restore`, {
      method: 'POST',
    });
    if (!res.ok) setError(problemMsg(res.problem) ?? 'Restore failed');
    setBusyId(null);
    startTransition(() => router.refresh());
  }

  // -- columns ------------------------------------------------------------
  const columns: DataColumn<SubnetRow>[] = [
    {
      id: 'name',
      header: 'Name',
      sortValue: (r) => r.name.toLowerCase(),
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{r.name}</span>
          {r.archivedAt && <Tag tone="outline">archived</Tag>}
          {r.conflictCount > 0 && (
            <Tag tone="danger" mono={false}>
              {r.conflictCount} conflict{r.conflictCount > 1 ? 's' : ''}
            </Tag>
          )}
        </span>
      ),
    },
    {
      id: 'cidr',
      header: 'CIDR',
      width: 160,
      mono: true,
      sortValue: (r) => {
        const [host, prefix] = r.cidr.split('/');
        if (!host || !prefix) return null;
        return ipToInt(host) * 64 + Number(prefix);
      },
      render: (r) => r.cidr,
    },
    {
      id: 'vlan',
      header: 'VLAN',
      width: 80,
      sortValue: (r) => r.vlanId,
      render: (r) => (r.vlanId != null ? String(r.vlanId) : <span style={{ color: 'var(--dim)' }}>—</span>),
    },
    {
      id: 'gateway',
      header: 'Gateway',
      width: 140,
      mono: true,
      sortValue: (r) => (r.gateway ? ipToInt(r.gateway) : null),
      render: (r) => r.gateway ?? <span style={{ color: 'var(--dim)' }}>—</span>,
    },
    {
      id: 'util',
      header: 'Utilization',
      sortValue: (r) =>
        r.utilization.totalUsable > 0
          ? r.utilization.claimed / r.utilization.totalUsable
          : 0,
      render: (r) => <UtilizationCell row={r} />,
    },
  ];

  if (canManage) {
    columns.push({
      id: 'actions',
      header: '',
      width: 200,
      align: 'right',
      sortable: false,
      render: (r) => {
        const archived = !!r.archivedAt;
        return (
          <div
            style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end', opacity: busyId === r.id ? 0.5 : 1 }}
          >
            <Btn
              size="sm"
              kind="ghost"
              icon={Icon.edit}
              onClick={() => setDialog({ kind: 'edit', row: r })}
            >
              Edit
            </Btn>
            {archived ? (
              <Btn
                size="sm"
                kind="ghost"
                icon={Icon.refresh}
                onClick={() => restore(r.id)}
              >
                Restore
              </Btn>
            ) : (
              <Btn
                size="sm"
                kind="ghost"
                icon={Icon.archive}
                onClick={() => archive(r.id)}
              >
                Archive
              </Btn>
            )}
          </div>
        );
      },
    });
  }

  return (
    <div>
      {error && (
        <div role="alert" style={{ padding: '8px 16px', color: 'var(--danger)', fontSize: 13 }}>
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        empty="No subnets yet. Add one to start tracking IP address space."
        rowHref={(r) => `/admin/companies/${companyId}/ipam/${r.id}`}
        renderMobileCard={(r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--text)',
              }}
            >
              {r.name}
              {r.archivedAt && <Tag tone="outline">archived</Tag>}
              {r.conflictCount > 0 && (
                <Tag tone="danger" mono={false}>
                  {r.conflictCount} conflict{r.conflictCount > 1 ? 's' : ''}
                </Tag>
              )}
            </div>
            <MobileCardRow label="CIDR" mono>
              {r.cidr}
            </MobileCardRow>
            {r.vlanId != null && (
              <MobileCardRow label="VLAN">{String(r.vlanId)}</MobileCardRow>
            )}
            {r.gateway && (
              <MobileCardRow label="Gateway" mono>
                {r.gateway}
              </MobileCardRow>
            )}
            <MobileCardRow label="Util">
              <UtilizationCell row={r} />
            </MobileCardRow>
            {canManage && (
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  marginTop: 4,
                  justifyContent: 'flex-end',
                }}
              >
                <Btn
                  size="sm"
                  kind="ghost"
                  icon={Icon.edit}
                  onClick={() => setDialog({ kind: 'edit', row: r })}
                >
                  Edit
                </Btn>
                {r.archivedAt ? (
                  <Btn
                    size="sm"
                    kind="ghost"
                    icon={Icon.refresh}
                    onClick={() => restore(r.id)}
                  >
                    Restore
                  </Btn>
                ) : (
                  <Btn
                    size="sm"
                    kind="ghost"
                    icon={Icon.archive}
                    onClick={() => archive(r.id)}
                  >
                    Archive
                  </Btn>
                )}
              </div>
            )}
          </div>
        )}
      />

      {dialog && (
        <SubnetDialog
          initial={dialog.kind === 'edit' ? dialog.row : null}
          onSubmit={(f) =>
            submit(
              f,
              dialog.kind === 'edit' ? 'edit' : 'add',
              dialog.kind === 'edit' ? dialog.row.id : null,
            )
          }
          onClose={closeDialog}
          error={error}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utilization cell (used in both desktop column + mobile card)
// ---------------------------------------------------------------------------

function UtilizationCell({ row }: { row: SubnetRow }) {
  const pct =
    row.utilization.totalUsable > 0
      ? Math.round((row.utilization.claimed / row.utilization.totalUsable) * 100)
      : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: 'var(--panel-2)',
          overflow: 'hidden',
          minWidth: 60,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 3,
            background:
              pct > 90
                ? 'var(--danger)'
                : pct > 70
                  ? 'var(--warn)'
                  : 'var(--accent)',
          }}
        />
      </div>
      <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
        {row.utilization.claimed}/{row.utilization.totalUsable}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subnet create/edit dialog
// ---------------------------------------------------------------------------

type SubnetForm = {
  name: string;
  cidr: string;
  vlanId: string;
  gateway: string;
  dhcpRangeStart: string;
  dhcpRangeEnd: string;
  description: string;
};

function SubnetDialog({
  initial,
  onSubmit,
  onClose,
  error,
}: {
  initial: SubnetRow | null;
  onSubmit: (f: SubnetForm) => Promise<void>;
  onClose: () => void;
  error: string | null;
}) {
  const [form, setForm] = useState<SubnetForm>({
    name: initial?.name ?? '',
    cidr: initial?.cidr ?? '',
    vlanId: initial?.vlanId != null ? String(initial.vlanId) : '',
    gateway: initial?.gateway ?? '',
    dhcpRangeStart: initial?.dhcpRangeStart ?? '',
    dhcpRangeEnd: initial?.dhcpRangeEnd ?? '',
    description: initial?.description ?? '',
  });
  const [saving, setSaving] = useState(false);

  function patch(key: keyof SubnetForm, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  // Real-time CIDR / gateway validation.
  const cidrErr = form.cidr.trim() && !isValidCidr(form.cidr.trim())
    ? 'Must be a valid IPv4 CIDR (e.g. 10.0.0.0/24)'
    : null;
  const gatewayErr =
    form.gateway.trim() && !isValidIpv4(form.gateway.trim())
      ? 'Must be a valid IPv4 address'
      : form.gateway.trim() &&
          form.cidr.trim() &&
          isValidCidr(form.cidr.trim()) &&
          !ipInCidrV4(form.gateway.trim(), form.cidr.trim())
        ? `Outside subnet ${form.cidr.trim()}`
        : null;

  const dhcpStart = form.dhcpRangeStart.trim();
  const dhcpEnd = form.dhcpRangeEnd.trim();
  const cidrValid = !!form.cidr.trim() && isValidCidr(form.cidr.trim());
  const dhcpStartErr = dhcpStart
    ? !isValidIpv4(dhcpStart)
      ? 'Must be a valid IPv4 address'
      : cidrValid && !ipInCidrV4(dhcpStart, form.cidr.trim())
        ? `Outside subnet ${form.cidr.trim()}`
        : !dhcpEnd
          ? 'End is also required'
          : null
    : dhcpEnd
      ? 'Start is also required'
      : null;
  const dhcpEndErr = dhcpEnd
    ? !isValidIpv4(dhcpEnd)
      ? 'Must be a valid IPv4 address'
      : cidrValid && !ipInCidrV4(dhcpEnd, form.cidr.trim())
        ? `Outside subnet ${form.cidr.trim()}`
        : dhcpStart &&
            isValidIpv4(dhcpStart) &&
            ipToInt(dhcpStart) > ipToInt(dhcpEnd)
          ? 'End must be ≥ start'
          : null
    : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (cidrErr || gatewayErr || dhcpStartErr || dhcpEndErr) return;
    setSaving(true);
    await onSubmit(form);
    setSaving(false);
  }

  const submitDisabled =
    saving ||
    !form.name.trim() ||
    !form.cidr.trim() ||
    !!cidrErr ||
    !!gatewayErr ||
    !!dhcpStartErr ||
    !!dhcpEndErr;

  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? 'Edit subnet' : 'New subnet'}
      width={480}
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <Field label="Name">
          <Input
            value={form.name}
            onChange={(e) => patch('name', e.target.value)}
            required
            placeholder="Office LAN"
            autoFocus
          />
        </Field>

        <Field label="CIDR" error={cidrErr ?? undefined}>
          <Input
            value={form.cidr}
            onChange={(e) => patch('cidr', e.target.value)}
            required
            spellCheck={false}
            autoComplete="off"
            style={{ fontFamily: 'var(--font-mono)' }}
            placeholder="10.0.0.0/24"
          />
        </Field>

        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="VLAN ID" style={{ flex: 1 }}>
            <Input
              value={form.vlanId}
              onChange={(e) => patch('vlanId', e.target.value)}
              type="number"
              min={1}
              max={4094}
              placeholder="100"
            />
          </Field>
          <Field
            label="Gateway"
            error={gatewayErr ?? undefined}
            style={{ flex: 1 }}
          >
            <Input
              value={form.gateway}
              onChange={(e) => patch('gateway', e.target.value)}
              spellCheck={false}
              autoComplete="off"
              style={{ fontFamily: 'var(--font-mono)' }}
              placeholder="10.0.0.1"
            />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <Field
            label="DHCP range start"
            error={dhcpStartErr ?? undefined}
            help="Optional. First IP of the DHCP scope."
            style={{ flex: 1 }}
          >
            <Input
              value={form.dhcpRangeStart}
              onChange={(e) => patch('dhcpRangeStart', e.target.value)}
              spellCheck={false}
              autoComplete="off"
              style={{ fontFamily: 'var(--font-mono)' }}
              placeholder="10.0.0.100"
            />
          </Field>
          <Field
            label="DHCP range end"
            error={dhcpEndErr ?? undefined}
            help="Last IP of the DHCP scope."
            style={{ flex: 1 }}
          >
            <Input
              value={form.dhcpRangeEnd}
              onChange={(e) => patch('dhcpRangeEnd', e.target.value)}
              spellCheck={false}
              autoComplete="off"
              style={{ fontFamily: 'var(--font-mono)' }}
              placeholder="10.0.0.199"
            />
          </Field>
        </div>

        <Field label="Description">
          <Textarea
            value={form.description}
            onChange={(e) => patch('description', e.target.value)}
            rows={3}
            placeholder="Optional notes about this subnet…"
          />
        </Field>

        {error && (
          <div role="alert" style={{ color: 'var(--danger)', fontSize: 13 }}>
            {error}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 4,
          }}
        >
          <Btn kind="ghost" type="button" onClick={onClose}>
            Cancel
          </Btn>
          <Btn kind="primary" type="submit" disabled={submitDisabled}>
            {saving ? 'Saving…' : initial ? 'Save' : 'Create'}
          </Btn>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function problemMsg(p: unknown): string | null {
  if (!p || typeof p !== 'object') return null;
  const obj = p as Record<string, unknown>;
  if (typeof obj.detail === 'string') return obj.detail;
  if (typeof obj.message === 'string') return obj.message;
  return null;
}

function isValidIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  return [+m[1]!, +m[2]!, +m[3]!, +m[4]!].every((o) => o >= 0 && o <= 255);
}

function isValidCidr(cidr: string): boolean {
  const idx = cidr.indexOf('/');
  if (idx < 0) return false;
  const host = cidr.slice(0, idx);
  const prefix = Number(cidr.slice(idx + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  return isValidIpv4(host);
}

function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

function ipInCidrV4(ip: string, cidr: string): boolean {
  if (!isValidIpv4(ip) || !isValidCidr(cidr)) return false;
  const [host, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(host!) & mask) >>> 0);
}
