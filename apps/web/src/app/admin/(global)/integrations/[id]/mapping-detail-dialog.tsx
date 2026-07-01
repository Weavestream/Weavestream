'use client';

import { useState } from 'react';
import type {
  IntegrationCompanyMappingDto,
  IntegrationDto,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import { FormattedDateTime } from '../../../../../lib/timezone-context';
import {
  Btn,
  Dialog,
  Field,
  Icon,
  Select,
  Tag,
  useToast,
} from '../../../../../components/ui';

/**
 * Phase 11 — per-mapping editor (lightweight).
 *
 * After the global field-mapping refactor (D-021), this dialog only
 * controls properties that are genuinely scoped to a single
 * `IntegrationCompanyMapping`:
 *   - enabled / paused
 *   - delete (releases linked assets, never deletes)
 *
 * Layout, match keys, and field projections live globally on the
 * integration and are managed in the "Field mappings" tab.
 */
export function MappingDetailDialog({
  integration,
  mapping,
  closeAction,
  changedAction,
}: {
  integration: IntegrationDto;
  mapping: IntegrationCompanyMappingDto;
  closeAction: () => void;
  changedAction: () => void;
}) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(mapping.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    setPending(true);
    const res = await apiFetch(
      `/admin/integrations/${integration.id}/mappings/${mapping.id}`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) },
    );
    setPending(false);
    if (!res.ok) {
      const problem = res.problem as
        | { detail?: string; title?: string }
        | undefined;
      setError(problem?.detail ?? problem?.title ?? 'Could not save mapping.');
      return;
    }
    toast.push('Mapping saved.', 'ok');
    changedAction();
  }

  async function destroy() {
    if (
      !window.confirm(
        `Delete this mapping?\n\nLinked assets will be released — they remain in Weavestream but lose their integration link, and future syncs into this company will skip until the mapping is recreated.`,
      )
    ) {
      return;
    }
    setPending(true);
    const res = await apiFetch(
      `/admin/integrations/${integration.id}/mappings/${mapping.id}`,
      { method: 'DELETE' },
    );
    setPending(false);
    if (!res.ok && res.status !== 204) {
      const problem = res.problem as
        | { detail?: string; title?: string }
        | undefined;
      toast.push(
        problem?.detail ?? problem?.title ?? 'Could not delete mapping.',
        'danger',
      );
      return;
    }
    toast.push('Mapping deleted, assets released.', 'ok');
    changedAction();
  }

  return (
    <Dialog
      open
      onClose={closeAction}
      title={`${mapping.externalOrgName ?? mapping.externalOrgId} → ${mapping.companyName ?? mapping.companyId.slice(0, 8)}`}
      width={520}
      footer={
        <>
          <Btn
            kind="ghost"
            icon={Icon.trash}
            onClick={destroy}
            disabled={pending}
            style={{ color: 'var(--danger)', marginRight: 'auto' }}
          >
            Delete mapping
          </Btn>
          <Btn kind="ghost" onClick={closeAction} disabled={pending}>
            Close
          </Btn>
          <Btn kind="primary" onClick={save} loading={pending}>
            Save changes
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Field label="Status" help="Pause to skip this org during scheduled syncs.">
          <Select
            value={enabled ? 'on' : 'off'}
            onChange={(e) => setEnabled(e.target.value === 'on')}
          >
            <option value="on">Enabled — included in scheduled syncs</option>
            <option value="off">Paused — skipped until re-enabled</option>
          </Select>
        </Field>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
            fontSize: 12,
            color: 'var(--muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <span>upstream id: {mapping.externalOrgId}</span>
          <span>company id: {mapping.companyId.slice(0, 8)}…</span>
          <span>
            updated:{' '}
            <FormattedDateTime value={mapping.updatedAt} />
          </span>
        </div>

        <Tag tone="info">
          Field mappings, match keys, and target asset layout are
          configured globally for this integration. Changes there apply
          to every mapped company on the next sync.
        </Tag>

        {error && <Tag tone="danger">{error}</Tag>}
      </div>
    </Dialog>
  );
}
