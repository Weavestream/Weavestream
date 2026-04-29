'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import type {
  SubnetDetail,
  SubnetOccupant,
  IpReservationRow,
} from '../../../../../../lib/server-api';
import { apiFetch } from '../../../../../../lib/api';
import {
  Btn,
  DataTable,
  Dialog,
  Field,
  Icon,
  Input,
  LayoutSwatch,
  MobileCardRow,
  Panel,
  Tag,
  Textarea,
  type DataColumn,
} from '../../../../../../components/ui';
import { AddressGrid } from '../address-grid';

type Tab = 'occupants' | 'reservations' | 'grid';

// Combined row for the Occupants tab (includes reservations).
type OccupantRow =
  | {
      id: string;
      kind: 'asset';
      ip: string;
      occupant: SubnetOccupant;
      isConflict: boolean;
    }
  | {
      id: string;
      kind: 'reservation';
      ip: string;
      reservation: IpReservationRow;
    };

export function SubnetDetailView({
  companyId,
  detail,
  canManage,
}: {
  companyId: string;
  detail: SubnetDetail;
  canManage: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>('occupants');
  const [resDialog, setResDialog] = useState<
    | { kind: 'add' }
    | { kind: 'edit'; row: IpReservationRow }
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const { subnet, utilization, occupants, reservations, conflicts } = detail;
  const pct =
    utilization.totalUsable > 0
      ? Math.round((utilization.claimed / utilization.totalUsable) * 100)
      : 0;

  const conflictIps = useMemo(
    () => new Set(conflicts.map((c) => c.ip)),
    [conflicts],
  );

  // Combined rows for the Occupants tab — assets first, then reservations
  // (sorted by IP within each group).
  const combinedRows = useMemo<OccupantRow[]>(() => {
    const assetRows: OccupantRow[] = occupants
      .map((o, i) => ({
        id: `a-${o.assetId}-${o.assetFieldId}-${i}`,
        kind: 'asset' as const,
        ip: o.ip,
        occupant: o,
        isConflict: conflictIps.has(o.ip),
      }))
      .sort((a, b) => compareIp(a.ip, b.ip));
    const reservationRows: OccupantRow[] = reservations
      .map((r) => ({
        id: `r-${r.id}`,
        kind: 'reservation' as const,
        ip: r.ipAddress,
        reservation: r,
      }))
      .sort((a, b) => compareIp(a.ip, b.ip));
    return [...assetRows, ...reservationRows];
  }, [occupants, reservations, conflictIps]);

  // ---- mutations ---------------------------------------------------------
  async function submitReservation(
    form: ResForm,
    mode: 'add' | 'edit',
    id: string | null,
  ) {
    setError(null);
    const body = {
      ipAddress: form.ipAddress.trim(),
      label: form.label.trim(),
      notes: form.notes?.trim() || null,
    };
    const res =
      mode === 'add'
        ? await apiFetch(
            `/companies/${companyId}/ipam/subnets/${subnet.id}/reservations`,
            { method: 'POST', body: JSON.stringify(body) },
          )
        : await apiFetch(
            `/companies/${companyId}/ipam/subnets/${subnet.id}/reservations/${id}`,
            { method: 'PATCH', body: JSON.stringify(body) },
          );
    if (!res.ok) {
      setError(problemMsg(res.problem) ?? 'Save failed');
      return;
    }
    setResDialog(null);
    startTransition(() => router.refresh());
  }

  async function deleteReservation(id: string) {
    setError(null);
    const res = await apiFetch(
      `/companies/${companyId}/ipam/subnets/${subnet.id}/reservations/${id}`,
      { method: 'DELETE' },
    );
    if (!res.ok) setError(problemMsg(res.problem) ?? 'Delete failed');
    startTransition(() => router.refresh());
  }

  // ---- column definitions -----------------------------------------------
  const occupantColumns: DataColumn<OccupantRow>[] = [
    {
      id: 'ip',
      header: 'IP',
      width: 160,
      mono: true,
      sortValue: (r) => ipToInt(r.ip),
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {r.ip}
          {r.kind === 'reservation' && (
            <Tag tone="info" mono={false}>
              reserved
            </Tag>
          )}
          {r.kind === 'asset' && r.isConflict && (
            <Tag tone="danger" mono={false}>
              conflict
            </Tag>
          )}
        </span>
      ),
    },
    {
      id: 'name',
      header: 'Asset / label',
      sortValue: (r) =>
        r.kind === 'reservation'
          ? r.reservation.label.toLowerCase()
          : r.occupant.assetName.toLowerCase(),
      render: (r) => {
        if (r.kind === 'reservation') {
          return (
            <span style={{ color: 'var(--text)' }}>{r.reservation.label}</span>
          );
        }
        return (
          <Link
            href={`/admin/companies/${companyId}/assets/${r.occupant.assetId}`}
            style={{ color: 'var(--accent)', textDecoration: 'none' }}
          >
            {r.occupant.assetName}
          </Link>
        );
      },
    },
    {
      id: 'layout',
      header: 'Layout',
      sortValue: (r) =>
        r.kind === 'reservation'
          ? null
          : r.occupant.assetLayoutName.toLowerCase(),
      render: (r) => {
        if (r.kind === 'reservation') {
          return (
            <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>
              Manual reservation
            </span>
          );
        }
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <LayoutSwatch
              icon={r.occupant.assetLayoutIcon}
              color={r.occupant.assetLayoutColor}
              size={16}
            />
            {r.occupant.assetLayoutName}
          </span>
        );
      },
    },
    {
      id: 'field',
      header: 'Field / notes',
      sortValue: (r) => {
        if (r.kind === 'asset') return r.occupant.fieldName.toLowerCase();
        return r.reservation.notes?.toLowerCase() ?? null;
      },
      render: (r) =>
        r.kind === 'asset'
          ? r.occupant.fieldName
          : r.reservation.notes ?? (
              <span style={{ color: 'var(--dim)' }}>—</span>
            ),
    },
  ];

  if (canManage) {
    occupantColumns.push({
      id: 'actions',
      header: '',
      width: 180,
      align: 'right',
      sortable: false,
      render: (r) => {
        if (r.kind !== 'reservation') return null;
        return (
          <div
            style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}
          >
            <Btn
              size="sm"
              kind="ghost"
              icon={Icon.edit}
              onClick={() =>
                setResDialog({ kind: 'edit', row: r.reservation })
              }
            >
              Edit
            </Btn>
            <Btn
              size="sm"
              kind="ghost"
              icon={Icon.trash}
              onClick={() => deleteReservation(r.reservation.id)}
            >
              Delete
            </Btn>
          </div>
        );
      },
    });
  }

  const reservationColumns: DataColumn<IpReservationRow>[] = [
    {
      id: 'ip',
      header: 'IP',
      width: 160,
      mono: true,
      sortValue: (r) => ipToInt(r.ipAddress),
      render: (r) => r.ipAddress,
    },
    {
      id: 'label',
      header: 'Label',
      sortValue: (r) => r.label.toLowerCase(),
      render: (r) => <span style={{ color: 'var(--text)' }}>{r.label}</span>,
    },
    {
      id: 'notes',
      header: 'Notes',
      sortValue: (r) => r.notes?.toLowerCase() ?? null,
      render: (r) =>
        r.notes ?? <span style={{ color: 'var(--dim)' }}>—</span>,
    },
  ];

  if (canManage) {
    reservationColumns.push({
      id: 'actions',
      header: '',
      width: 180,
      align: 'right',
      sortable: false,
      render: (r) => (
        <div
          style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}
        >
          <Btn
            size="sm"
            kind="ghost"
            icon={Icon.edit}
            onClick={() => setResDialog({ kind: 'edit', row: r })}
          >
            Edit
          </Btn>
          <Btn
            size="sm"
            kind="ghost"
            icon={Icon.trash}
            onClick={() => deleteReservation(r.id)}
          >
            Delete
          </Btn>
        </div>
      ),
    });
  }

  // ---- render ------------------------------------------------------------
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Metadata row */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
        {subnet.vlanId != null && (
          <MetaItem label="VLAN" value={String(subnet.vlanId)} />
        )}
        {subnet.gateway && <MetaItem label="Gateway" value={subnet.gateway} mono />}
        <MetaItem label="Prefix" value={`/${subnet.prefix}`} mono />
      </div>

      {/* Utilization bar */}
      <div
        style={{
          padding: 16,
          borderRadius: 8,
          background: 'var(--panel)',
          border: '1px solid var(--line)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginBottom: 8,
            fontSize: 13,
          }}
        >
          <span style={{ fontWeight: 500 }}>Utilization</span>
          <span style={{ color: 'var(--muted)' }}>
            {utilization.claimed} used / {utilization.free} free /{' '}
            {utilization.totalUsable} total
          </span>
        </div>
        <div
          style={{
            height: 10,
            borderRadius: 5,
            background: 'var(--panel-2)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 5,
              background:
                pct > 90
                  ? 'var(--danger)'
                  : pct > 70
                    ? 'var(--warn)'
                    : 'var(--accent)',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      </div>

      {/* Conflict banner */}
      {conflicts.length > 0 && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 8,
            background: 'var(--danger-soft)',
            border: '1px solid var(--danger)',
            fontSize: 13,
            color: 'var(--text)',
          }}
        >
          <strong>IP conflicts detected:</strong>{' '}
          {conflicts.map((c) => c.ip).join(', ')} — multiple assets share the
          same address.
        </div>
      )}

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--line)',
          overflowX: 'auto',
        }}
      >
        {(['occupants', 'reservations', 'grid'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? 'var(--accent)' : 'var(--muted)',
              background: 'transparent',
              border: 'none',
              borderBottom:
                tab === t
                  ? '2px solid var(--accent)'
                  : '2px solid transparent',
              cursor: 'pointer',
              textTransform: 'capitalize',
              whiteSpace: 'nowrap',
            }}
          >
            {t === 'grid' ? 'Address space' : t}
            {t === 'occupants' && (
              <span style={{ marginLeft: 4, opacity: 0.6 }}>
                {combinedRows.length}
              </span>
            )}
            {t === 'reservations' && (
              <span style={{ marginLeft: 4, opacity: 0.6 }}>
                {reservations.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {tab === 'occupants' && (
        <Panel
          title={`${combinedRows.length} occupant${combinedRows.length === 1 ? '' : 's'}`}
          noPad
        >
        <DataTable
          columns={occupantColumns}
          rows={combinedRows}
          empty="No assets or reservations in this subnet yet."
          renderMobileCard={(r) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {r.ip}
                {r.kind === 'reservation' && (
                  <Tag tone="info" mono={false}>
                    reserved
                  </Tag>
                )}
                {r.kind === 'asset' && r.isConflict && (
                  <Tag tone="danger" mono={false}>
                    conflict
                  </Tag>
                )}
              </div>
              {r.kind === 'asset' ? (
                <>
                  <MobileCardRow label="Asset">
                    <Link
                      href={`/admin/companies/${companyId}/assets/${r.occupant.assetId}`}
                      style={{
                        color: 'var(--accent)',
                        textDecoration: 'none',
                      }}
                    >
                      {r.occupant.assetName}
                    </Link>
                  </MobileCardRow>
                  <MobileCardRow label="Layout">
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <LayoutSwatch
                        icon={r.occupant.assetLayoutIcon}
                        color={r.occupant.assetLayoutColor}
                        size={14}
                      />
                      {r.occupant.assetLayoutName}
                    </span>
                  </MobileCardRow>
                  <MobileCardRow label="Field">
                    {r.occupant.fieldName}
                  </MobileCardRow>
                </>
              ) : (
                <>
                  <MobileCardRow label="Label">
                    {r.reservation.label}
                  </MobileCardRow>
                  {r.reservation.notes && (
                    <MobileCardRow label="Notes">
                      {r.reservation.notes}
                    </MobileCardRow>
                  )}
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
                        onClick={() =>
                          setResDialog({ kind: 'edit', row: r.reservation })
                        }
                      >
                        Edit
                      </Btn>
                      <Btn
                        size="sm"
                        kind="ghost"
                        icon={Icon.trash}
                        onClick={() => deleteReservation(r.reservation.id)}
                      >
                        Delete
                      </Btn>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        />
        </Panel>
      )}

      {tab === 'reservations' && (
        <Panel
          title={`${reservations.length} reservation${reservations.length === 1 ? '' : 's'}`}
          actions={
            canManage ? (
              <Btn
                kind="primary"
                size="sm"
                icon={Icon.plus}
                onClick={() => setResDialog({ kind: 'add' })}
              >
                New reservation
              </Btn>
            ) : undefined
          }
          noPad
        >
          <DataTable
            columns={reservationColumns}
            rows={reservations}
            empty="No reservations yet. Use a reservation to pin an IP to a label without creating a full asset record."
            renderMobileCard={(r) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {r.ipAddress}
                </div>
                <MobileCardRow label="Label">{r.label}</MobileCardRow>
                {r.notes && (
                  <MobileCardRow label="Notes">{r.notes}</MobileCardRow>
                )}
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
                      onClick={() => setResDialog({ kind: 'edit', row: r })}
                    >
                      Edit
                    </Btn>
                    <Btn
                      size="sm"
                      kind="ghost"
                      icon={Icon.trash}
                      onClick={() => deleteReservation(r.id)}
                    >
                      Delete
                    </Btn>
                  </div>
                )}
              </div>
            )}
          />
        </Panel>
      )}

      {tab === 'grid' && (
        <AddressGrid
          cidr={subnet.cidr}
          prefix={subnet.prefix}
          occupants={occupants}
          reservations={reservations}
          companyId={companyId}
        />
      )}

      {resDialog && (
        <ReservationDialog
          subnetCidr={subnet.cidr}
          subnetPrefix={subnet.prefix}
          existingIps={
            new Set([
              ...occupants.map((o) => o.ip),
              ...reservations
                .filter(
                  (r) =>
                    resDialog.kind !== 'edit' ||
                    r.id !== resDialog.row.id,
                )
                .map((r) => r.ipAddress),
            ])
          }
          initial={resDialog.kind === 'edit' ? resDialog.row : null}
          onSubmit={(f) =>
            submitReservation(
              f,
              resDialog.kind === 'edit' ? 'edit' : 'add',
              resDialog.kind === 'edit' ? resDialog.row.id : null,
            )
          }
          onClose={() => {
            setResDialog(null);
            setError(null);
          }}
          error={error}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reservation dialog with real-time IP validation + prefix prefill
// ---------------------------------------------------------------------------

type ResForm = { ipAddress: string; label: string; notes: string };

function ReservationDialog({
  subnetCidr,
  subnetPrefix,
  existingIps,
  initial,
  onSubmit,
  onClose,
  error,
}: {
  subnetCidr: string;
  subnetPrefix: number;
  existingIps: Set<string>;
  initial: IpReservationRow | null;
  onSubmit: (f: ResForm) => Promise<void>;
  onClose: () => void;
  error: string | null;
}) {
  // Prefill the host portion based on the prefix length so the user only
  // types the variable octets. e.g. /24 -> "10.0.0." prefilled.
  const prefill = useMemo(
    () => prefillForPrefix(subnetCidr, subnetPrefix),
    [subnetCidr, subnetPrefix],
  );

  const [form, setForm] = useState<ResForm>({
    ipAddress: initial?.ipAddress ?? prefill,
    label: initial?.label ?? '',
    notes: initial?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);

  function patch(key: keyof ResForm, val: string) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  // Real-time validation against the subnet boundary + duplicate check.
  const ipValidation = useMemo(() => {
    const v = form.ipAddress.trim();
    if (!v) return { kind: 'idle' as const };
    if (!isValidIpv4(v)) {
      return { kind: 'error' as const, message: 'Not a valid IPv4 address' };
    }
    if (!ipInCidrV4(v, subnetCidr)) {
      return {
        kind: 'error' as const,
        message: `Outside subnet ${subnetCidr}`,
      };
    }
    if (existingIps.has(v)) {
      return {
        kind: 'error' as const,
        message: 'Already in use',
      };
    }
    return { kind: 'ok' as const };
  }, [form.ipAddress, subnetCidr, existingIps]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (ipValidation.kind === 'error') return;
    setSaving(true);
    await onSubmit(form);
    setSaving(false);
  }

  const submitDisabled =
    saving ||
    ipValidation.kind !== 'ok' ||
    !form.label.trim();

  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? 'Edit reservation' : 'New reservation'}
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <Field
          label="IP address"
          error={
            ipValidation.kind === 'error' ? ipValidation.message : undefined
          }
          help={
            ipValidation.kind === 'idle'
              ? `Within ${subnetCidr}`
              : ipValidation.kind === 'ok'
                ? 'Valid'
                : undefined
          }
        >
          <Input
            value={form.ipAddress}
            onChange={(e) => patch('ipAddress', e.target.value)}
            required
            spellCheck={false}
            autoComplete="off"
            style={{ fontFamily: 'var(--font-mono)' }}
            placeholder={subnetCidr.split('/')[0]}
          />
        </Field>

        <Field label="Label">
          <Input
            value={form.label}
            onChange={(e) => patch('label', e.target.value)}
            required
            placeholder="Router, Printer, …"
            autoFocus={!!initial}
          />
        </Field>

        <Field label="Notes">
          <Textarea
            value={form.notes}
            onChange={(e) => patch('notes', e.target.value)}
            rows={3}
            placeholder="Optional"
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
// Primitives + IP helpers (kept local to avoid leaking utilities)
// ---------------------------------------------------------------------------

function MetaItem({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{
          fontSize: 11,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontWeight: 500,
          fontFamily: mono ? 'var(--font-mono)' : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

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

function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

function ipInCidrV4(ip: string, cidr: string): boolean {
  if (!isValidIpv4(ip)) return false;
  const [host, prefixStr] = cidr.split('/');
  if (!host || !prefixStr) return false;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(host) & mask) >>> 0);
}

function compareIp(a: string, b: string): number {
  return ipToInt(a) - ipToInt(b);
}

/**
 * Returns the fixed octets of the network as a string ending in `.` so the
 * user only has to fill in the variable portion. /24 -> "10.0.0.", /16 ->
 * "10.0.", /8 -> "10.", /32 -> "10.0.0.5" (full address). For non-octet
 * boundary prefixes (/25, /17, …) we fall back to the full network address
 * so the user can edit the last octet without confusing them with a partial
 * boundary.
 */
function prefillForPrefix(cidr: string, prefix: number): string {
  const [host] = cidr.split('/');
  if (!host) return '';
  if (prefix === 32) return host;
  if (prefix >= 24) {
    // /24..31 — first 3 octets are fixed.
    const parts = host.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.`;
  }
  if (prefix >= 16) {
    const parts = host.split('.');
    return `${parts[0]}.${parts[1]}.`;
  }
  if (prefix >= 8) {
    const parts = host.split('.');
    return `${parts[0]}.`;
  }
  return '';
}
