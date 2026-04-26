'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  DriverDescriptor,
  IntegrationCompanyMappingDto,
  SourceOrgDto,
} from '@weavestream/shared';
import { apiFetch } from '../../../../../lib/api';
import {
  Btn,
  CompanyPicker,
  Dialog,
  Field,
  Select,
  Tag,
  type CompanyPickerValue,
} from '../../../../../components/ui';

/**
 * Phase 11 — create-mapping dialog.
 *
 * Two coupled selections:
 *   1. Upstream organization (driver-supplied list, when supported).
 *   2. Weavestream company (typeahead).
 *
 * Asset layout, match-keys, and field mappings are now configured
 * GLOBALLY on the integration (see the "Field mappings" tab) and
 * apply uniformly to every per-company mapping.
 */
export function CreateMappingDialog({
  integrationId,
  driver,
  hasGlobalLayout,
  existingExternalOrgIds,
  onClose,
  onCreated,
}: {
  integrationId: string;
  driver: DriverDescriptor | null;
  hasGlobalLayout: boolean;
  existingExternalOrgIds: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [orgs, setOrgs] = useState<SourceOrgDto[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsError, setOrgsError] = useState<string | null>(null);

  const [externalOrg, setExternalOrg] = useState<SourceOrgDto | null>(null);
  const [externalOrgManual, setExternalOrgManual] = useState('');
  const [company, setCompany] = useState<CompanyPickerValue | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supportsListOrgs = driver?.capabilities.listSourceOrgs ?? false;
  const claimedExternalIds = useMemo(
    () => new Set(existingExternalOrgIds),
    [existingExternalOrgIds],
  );

  useEffect(() => {
    if (!supportsListOrgs) return;
    let cancelled = false;
    (async () => {
      setOrgsLoading(true);
      setOrgsError(null);
      const res = await apiFetch<{ orgs: SourceOrgDto[] }>(
        `/admin/integrations/${integrationId}/source-orgs`,
      );
      if (cancelled) return;
      setOrgsLoading(false);
      if (!res.ok || !res.data) {
        const problem = res.problem as
          | { detail?: string; title?: string }
          | undefined;
        setOrgsError(
          problem?.detail ??
            problem?.title ??
            'Could not list upstream organizations — verify credentials.',
        );
        return;
      }
      setOrgs(res.data.orgs);
    })();
    return () => {
      cancelled = true;
    };
  }, [integrationId, supportsListOrgs]);

  const valid = useMemo(() => {
    const orgId = supportsListOrgs ? externalOrg?.externalId : externalOrgManual.trim();
    return Boolean(orgId && company);
  }, [supportsListOrgs, externalOrg, externalOrgManual, company]);

  async function submit() {
    setError(null);
    setPending(true);
    const externalOrgId = supportsListOrgs
      ? externalOrg?.externalId ?? ''
      : externalOrgManual.trim();
    const externalOrgName =
      (supportsListOrgs ? externalOrg?.name : null) ?? null;
    const res = await apiFetch<IntegrationCompanyMappingDto>(
      `/admin/integrations/${integrationId}/mappings`,
      {
        method: 'POST',
        body: JSON.stringify({
          companyId: company!.id,
          externalOrgId,
          externalOrgName,
          enabled: true,
          filter: {},
        }),
      },
    );
    setPending(false);
    if (!res.ok || !res.data) {
      const problem = res.problem as
        | { detail?: string; title?: string }
        | undefined;
      setError(problem?.detail ?? problem?.title ?? 'Could not create mapping.');
      return;
    }
    onCreated();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Map an organization"
      width={520}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Btn>
          <Btn kind="primary" onClick={submit} loading={pending} disabled={!valid}>
            Create mapping
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {supportsListOrgs ? (
          <Field
            label="Upstream organization"
            help="Driver-listed organizations from the connected account."
          >
            {orgsLoading ? (
              <Tag tone="default">Loading…</Tag>
            ) : orgsError ? (
              <Tag tone="danger">{orgsError}</Tag>
            ) : (
              <Select
                value={externalOrg?.externalId ?? ''}
                onChange={(e) => {
                  const next = orgs.find((o) => o.externalId === e.target.value) ?? null;
                  setExternalOrg(next);
                }}
              >
                <option value="">Select an organization…</option>
                {orgs.map((o) => {
                  const claimed = claimedExternalIds.has(o.externalId);
                  return (
                    <option
                      key={o.externalId}
                      value={o.externalId}
                      disabled={claimed}
                    >
                      {o.name}
                      {claimed ? ' — already mapped' : ''}
                      {o.hint ? ` (${o.hint})` : ''}
                    </option>
                  );
                })}
              </Select>
            )}
          </Field>
        ) : (
          <Field
            label="Upstream organization id"
            help="This driver does not list organizations — paste the external id."
          >
            <input
              value={externalOrgManual}
              onChange={(e) => setExternalOrgManual(e.target.value)}
              style={inputStyle}
            />
          </Field>
        )}

        <Field
          label="Weavestream company"
          help="Synced records will be inserted into this tenant."
        >
          <CompanyPicker value={company} onChange={setCompany} />
        </Field>

        {error && <Tag tone="danger">{error}</Tag>}

        {hasGlobalLayout ? (
          <Tag tone="info">
            This integration’s asset layout, match keys, and field
            mappings are configured globally — they’ll apply to this
            mapping automatically.
          </Tag>
        ) : (
          <Tag tone="warn">
            No global field mappings yet. After creating this mapping,
            open the “Field mappings” tab to pick a layout and project
            upstream fields before the next sync.
          </Tag>
        )}
      </div>
    </Dialog>
  );
}

const inputStyle: React.CSSProperties = {
  height: 32,
  padding: '0 10px',
  border: '1px solid var(--line-2)',
  borderRadius: 5,
  background: 'var(--panel)',
  color: 'var(--text)',
  fontSize: 13,
  fontFamily: 'var(--font-mono)',
};
