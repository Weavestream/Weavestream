'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Btn,
  DataTable,
  Dialog,
  Icon,
  Input,
  Select,
  Tag,
  useToast,
  type DataColumn,
} from '../../../../components/ui';
import { apiFetch } from '../../../../lib/api';
import type { IpRule, IpRuleAction } from '../../../../lib/server-api';

const IP_RULE_ACTION_LABELS: Record<IpRuleAction, string> = {
  ALLOW: 'Allow',
  DENY: 'Deny',
};

export function IpRulesTable({ initialRules }: { initialRules: IpRule[] }) {
  const router = useRouter();
  const toast = useToast();
  const [rules, setRules] = useState<IpRule[]>(initialRules);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<IpRule | null>(null);

  const columns = useMemo<DataColumn<IpRule>[]>(
    () => [
      {
        id: 'priority',
        header: 'Priority',
        width: 80,
        mono: true,
        render: (r) => <span style={{ color: 'var(--dim)' }}>{r.priority}</span>,
      },
      {
        id: 'cidr',
        header: 'IP / CIDR',
        width: 180,
        mono: true,
        render: (r) => (
          <span style={{ color: 'var(--text-2)', fontWeight: 500 }}>{r.cidr}</span>
        ),
      },
      {
        id: 'action',
        header: 'Action',
        width: 100,
        render: (r) => (
          <Tag tone={r.action === 'ALLOW' ? 'ok' : 'danger'}>
            {IP_RULE_ACTION_LABELS[r.action]}
          </Tag>
        ),
      },
      {
        id: 'note',
        header: 'Note',
        render: (r) => (
          <span
            style={{
              color: 'var(--muted)',
              fontSize: 12,
              display: 'inline-block',
              maxWidth: 300,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={r.note ?? undefined}
          >
            {r.note ?? '—'}
          </span>
        ),
      },
      {
        id: 'enabled',
        header: 'Enabled',
        width: 90,
        render: (r) => (
          <Tag tone={r.enabled ? 'ok' : 'default'}>
            {r.enabled ? 'Yes' : 'No'}
          </Tag>
        ),
      },
      {
        id: 'actions',
        header: '',
        width: 120,
        render: (r) => (
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn
              kind="ghost"
              size="sm"
              onClick={() => setEditing(r)}
              title="Edit"
              iconOnly
              icon={Icon.edit}
            />
            <Btn
              kind="ghost"
              size="sm"
              disabled={busyId === r.id}
              onClick={async () => {
                if (!confirm(`Delete rule ${r.cidr} (${r.action})?`)) return;
                setBusyId(r.id);
                const res = await apiFetch(`/ip-rules/${r.id}`, {
                  method: 'DELETE',
                });
                setBusyId(null);
                if (res.ok) {
                  toast.push('Rule deleted', 'ok');
                  setRules((prev) => prev.filter((x) => x.id !== r.id));
                } else {
                  toast.push('Failed to delete rule', 'danger');
                }
              }}
              title="Delete"
              iconOnly
              icon={Icon.trash}
            />
          </div>
        ),
      },
    ],
    [busyId, toast],
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <Btn kind="primary" onClick={() => setShowCreate(true)} icon={Icon.plus}>
          Add rule
        </Btn>
      </div>

      <DataTable
        columns={columns}
        rows={rules}
        disableSort
        empty="No IP rules. Create one to start enforcing IP-based access control."
        renderMobileCard={(r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{r.cidr}</strong>
              <Tag tone={r.action === 'ALLOW' ? 'ok' : 'danger'}>
                {IP_RULE_ACTION_LABELS[r.action]}
              </Tag>
            </div>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              Priority {r.priority} · {r.enabled ? 'Enabled' : 'Disabled'}
            </span>
            {r.note && (
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--dim)',
                  maxWidth: 260,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {r.note}
              </span>
            )}
          </div>
        )}
      />

      {showCreate && (
        <RuleDialog
          title="Add IP rule"
          onClose={() => setShowCreate(false)}
          onSave={async (data) => {
            const res = await apiFetch<IpRule>('/ip-rules', {
              method: 'POST',
              body: JSON.stringify(data),
            });
            if (res.ok && res.data) {
              toast.push('Rule created', 'ok');
              setRules((prev) => [...prev, res.data!].sort((a, b) => a.priority - b.priority));
              setShowCreate(false);
            } else {
              toast.push('Failed to create rule', 'danger');
            }
          }}
        />
      )}

      {editing && (
        <RuleDialog
          title="Edit IP rule"
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={async (data) => {
            const res = await apiFetch<IpRule>(`/ip-rules/${editing.id}`, {
              method: 'PATCH',
              body: JSON.stringify(data),
            });
            if (res.ok && res.data) {
              toast.push('Rule updated', 'ok');
              setRules((prev) =>
                prev
                  .map((r) => (r.id === editing.id ? res.data! : r))
                  .sort((a, b) => a.priority - b.priority),
              );
              setEditing(null);
            } else {
              toast.push('Failed to update rule', 'danger');
            }
          }}
        />
      )}
    </div>
  );
}

function RuleDialog({
  title,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  initial?: IpRule;
  onClose: () => void;
  onSave: (data: {
    cidr: string;
    action: IpRuleAction;
    priority: number;
    note: string | null;
    enabled: boolean;
  }) => Promise<void>;
}) {
  const [cidr, setCidr] = useState(initial?.cidr ?? '');
  const [action, setAction] = useState<IpRuleAction>(initial?.action ?? 'DENY');
  const [priority, setPriority] = useState(String(initial?.priority ?? 0));
  const [note, setNote] = useState(initial?.note ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open onClose={onClose} title={title}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 320 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>IP or CIDR *</span>
          <Input
            value={cidr}
            onChange={(e) => setCidr(e.target.value)}
            placeholder="192.168.1.1 or 10.0.0.0/8"
            autoFocus
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Action *</span>
          <Select
            value={action}
            onChange={(e) => setAction(e.target.value as IpRuleAction)}
          >
            <option value="ALLOW">Allow</option>
            <option value="DENY">Deny</option>
          </Select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Priority (lower = first)</span>
          <Input
            type="number"
            min={0}
            max={9999}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Note</span>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why this rule exists"
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span style={{ fontSize: 12 }}>Enabled</span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            disabled={busy || !cidr.trim()}
            onClick={async () => {
              setBusy(true);
              await onSave({
                cidr: cidr.trim(),
                action,
                priority: parseInt(priority, 10) || 0,
                note: note.trim() || null,
                enabled,
              });
              setBusy(false);
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </Btn>
        </div>
      </div>
    </Dialog>
  );
}
