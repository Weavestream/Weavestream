'use client';

import { useState } from 'react';
import {
  CUSTOM_API_DEVICE_STANDARD_FIELDS,
  CUSTOM_API_EXTRA_FIELD_TYPES,
  CUSTOM_API_LIMITS,
  type CustomApiTestKey,
  type CustomApiTestRecord,
} from '@weavestream/shared';
import { Btn, CheckboxOption, Field, Icon, Input, Select } from '../../../../../components/ui';
import {
  type CustomApiDraft,
  type DraftDevices,
  type DraftExtraField,
  type DraftIssues,
  type DraftResource,
} from './definition-draft';
import { PathInput, sampleFor } from './path-input';
import { PaginationFields, RequestFields, rowStyle, subLabelStyle } from './request-fields';
import { TestOrgPicker, TestPanel } from './test-panel';

type ResourceKey = 'devices' | 'other_assets';

const COPY: Record<ResourceKey, { title: string; toggle: string; matchLabel: string; matchHelp: string }> = {
  devices: {
    title: 'Devices',
    toggle: 'Read devices from this API',
    matchLabel: 'Serial number path',
    matchHelp: 'Devices match existing assets by serial number.',
  },
  other_assets: {
    title: 'Other assets',
    toggle: 'Read other assets from this API',
    matchLabel: 'Match value path (optional)',
    matchHelp: 'Records match existing assets by this value.',
  },
};

/**
 * One resource of the definition: on/off, request, paths and the Open in
 * link, with its own **Test**. Turning a resource off here means "the API
 * has no such records"; the resource tab still decides whether a run
 * syncs it.
 */
export function ResourceSection({
  resourceKey,
  value,
  onToggle,
  onChange,
  issues,
  definition,
  standardFieldLabels,
  organizations,
  integrationId,
  testSecret,
  testDisabledReason,
}: {
  resourceKey: ResourceKey;
  value: DraftResource | { enabled: false };
  onToggle: (enabled: boolean) => void;
  onChange: (next: DraftResource) => void;
  issues: DraftIssues;
  definition: CustomApiDraft;
  standardFieldLabels: Record<string, string>;
  /** The last Organizations Test result, for the organization picker. */
  organizations: CustomApiTestRecord[];
  integrationId: string | null;
  testSecret?: Record<string, string>;
  testDisabledReason: string | null;
}) {
  const [keys, setKeys] = useState<CustomApiTestKey[] | undefined>(undefined);
  const [orgId, setOrgId] = useState('');
  const copy = COPY[resourceKey];
  const id = `ca-${resourceKey}`;
  const at = `resources.${resourceKey}`;
  const mode = definition.organizations.mode;

  return (
    <section style={sectionStyle} aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`} style={headingStyle}>
        {copy.title}
      </h4>
      <CheckboxOption
        checked={value.enabled}
        onChange={onToggle}
        label={copy.toggle}
        hint="Off: the API has no such records. The resource tab still decides whether a run syncs this resource."
      />
      {value.enabled && (
        <EnabledResource
          id={id}
          at={at}
          resourceKey={resourceKey}
          value={value}
          onChange={onChange}
          issues={issues}
          mode={mode}
          keys={keys}
          standardFieldLabels={standardFieldLabels}
          matchLabel={copy.matchLabel}
          matchHelp={copy.matchHelp}
        />
      )}
      {value.enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {mode === 'endpoint' && (
            <TestOrgPicker id={`${id}-org`} organizations={organizations} value={orgId} onChange={setOrgId} />
          )}
          <TestPanel
            integrationId={integrationId}
            definition={definition}
            section={resourceKey}
            secret={testSecret}
            orgId={mode === 'endpoint' ? orgId.trim() || undefined : undefined}
            disabledReason={
              testDisabledReason ??
              (mode === 'endpoint' && orgId.trim() === '' ? 'Pick or type an organization id to test with.' : null)
            }
            onResult={(result) => setKeys(result?.ok ? result.keys : undefined)}
          />
        </div>
      )}
    </section>
  );
}

function EnabledResource({
  id,
  at,
  resourceKey,
  value,
  onChange,
  issues,
  mode,
  keys,
  standardFieldLabels,
  matchLabel,
  matchHelp,
}: {
  id: string;
  at: string;
  resourceKey: ResourceKey;
  value: DraftResource;
  onChange: (next: DraftResource) => void;
  issues: DraftIssues;
  mode: CustomApiDraft['organizations']['mode'];
  keys: CustomApiTestKey[] | undefined;
  standardFieldLabels: Record<string, string>;
  matchLabel: string;
  matchHelp: string;
}) {
  const path = (key: string, label: string, current: string | undefined, set: (next: string) => void, help?: string) => (
    <PathInput
      id={`${id}-${key}`}
      label={label}
      value={current ?? ''}
      error={issues.get(`${at}.${key}`)}
      help={help}
      sample={sampleFor(keys, current ?? '')}
      onChange={set}
    />
  );
  // An imported definition may leave out `standardFields` (its default is {}).
  const standard: Partial<Record<string, string>> = (value as DraftDevices).standardFields ?? {};
  const extraFields = value.extraFields ?? [];
  const setExtra = (next: DraftExtraField[]) => onChange({ ...value, extraFields: next });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RequestFields
        idPrefix={`${id}-request`}
        issuePath={`${at}.request`}
        value={value.request}
        onChange={(request) => onChange({ ...value, request })}
        issues={issues}
      />
      <PathInput
        id={`${id}-records`}
        label="Records path"
        value={value.recordsPath ?? ''}
        error={issues.get(`${at}.recordsPath`)}
        help="Where the response holds the list. Empty: the response is the list."
        onChange={(recordsPath) => onChange({ ...value, recordsPath })}
      />
      <PaginationFields
        idPrefix={`${id}-pages`}
        issuePath={`${at}.pagination`}
        value={value.pagination ?? { style: 'none' }}
        onChange={(pagination) => onChange({ ...value, pagination })}
        issues={issues}
      />
      <span style={subLabelStyle}>Paths in each record</span>
      <div style={gridStyle}>
        {path('idPath', 'Id path', value.idPath, (idPath) => onChange({ ...value, idPath }))}
        {path('namePath', 'Name path', value.namePath, (namePath) => onChange({ ...value, namePath }))}
        {path('matchPath', matchLabel, value.matchPath, (matchPath) => onChange({ ...value, matchPath }), matchHelp)}
        {mode !== 'single' &&
          path(
            'orgIdPath',
            mode === 'field' ? 'Organization id path' : 'Organization id path (optional)',
            value.orgIdPath,
            (orgIdPath) => onChange({ ...value, orgIdPath }),
            mode === 'field'
              ? 'Each record’s organization.'
              : 'If set, a record of another organization is dropped.',
          )}
        {mode === 'field' &&
          path('orgNamePath', 'Organization name path (optional)', value.orgNamePath, (orgNamePath) =>
            onChange({ ...value, orgNamePath }),
          )}
      </div>
      {resourceKey === 'devices' && (
        <>
          <span style={subLabelStyle}>Standard fields (optional)</span>
          <div style={gridStyle}>
            {CUSTOM_API_DEVICE_STANDARD_FIELDS.map((field) => (
              <PathInput
                key={field}
                id={`${id}-std-${field}`}
                label={standardFieldLabels[field] ?? field}
                value={standard[field] ?? ''}
                error={issues.get(`${at}.standardFields.${field}`)}
                sample={sampleFor(keys, standard[field] ?? '')}
                onChange={(next) => onChange({ ...value, standardFields: { ...standard, [field]: next } } as DraftDevices)}
              />
            ))}
          </div>
        </>
      )}
      <span style={subLabelStyle}>
        {resourceKey === 'devices' ? 'Extra fields (shown on the asset)' : 'Extra fields (mapped on the field mappings tab)'}
      </span>
      {extraFields.map((field, index) => (
        <div key={index} style={{ ...rowStyle, paddingBottom: 8, borderBottom: '1px solid var(--line)' }}>
          <Field label="Key" htmlFor={`${id}-x${index}-key`} error={issues.get(`${at}.extraFields.${index}.key`)} style={{ flex: '1 1 140px' }}>
            <Input
              id={`${id}-x${index}-key`}
              value={field.key}
              placeholder="agent_version"
              autoComplete="off"
              style={{ fontFamily: 'var(--font-mono)' }}
              onChange={(e) => setExtra(extraFields.map((f, i) => (i === index ? { ...f, key: e.target.value } : f)))}
            />
          </Field>
          <Field label="Label" htmlFor={`${id}-x${index}-label`} error={issues.get(`${at}.extraFields.${index}.label`)} style={{ flex: '1 1 140px' }}>
            <Input
              id={`${id}-x${index}-label`}
              value={field.label}
              autoComplete="off"
              onChange={(e) => setExtra(extraFields.map((f, i) => (i === index ? { ...f, label: e.target.value } : f)))}
            />
          </Field>
          <div style={{ flex: '2 1 180px' }}>
            <PathInput
              id={`${id}-x${index}-path`}
              label="Path"
              value={field.path}
              error={issues.get(`${at}.extraFields.${index}.path`)}
              sample={sampleFor(keys, field.path)}
              onChange={(next) => setExtra(extraFields.map((f, i) => (i === index ? { ...f, path: next } : f)))}
            />
          </div>
          <Field label="Type" htmlFor={`${id}-x${index}-type`} style={{ flex: '0 1 130px' }}>
            <Select
              id={`${id}-x${index}-type`}
              value={field.type}
              onChange={(e) =>
                setExtra(extraFields.map((f, i) => (i === index ? { ...f, type: e.target.value as DraftExtraField['type'] } : f)))
              }
            >
              {CUSTOM_API_EXTRA_FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </Field>
          <Btn
            kind="ghost"
            size="sm"
            icon={Icon.trash}
            aria-label={`Remove extra field ${index + 1}`}
            style={{ marginTop: 22 }}
            onClick={() => setExtra(extraFields.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <div>
        <Btn
          kind="ghost"
          size="sm"
          icon={Icon.plus}
          disabled={extraFields.length >= CUSTOM_API_LIMITS.extraFieldsPerResource}
          onClick={() => setExtra([...extraFields, { key: '', label: '', path: '', type: 'TEXT' }])}
        >
          Add extra field
        </Btn>
      </div>
      <Field
        label="Open in link (optional)"
        htmlFor={`${id}-url`}
        error={issues.get(`${at}.recordUrl`)}
        help="HTTPS. {id} is replaced by the record id, for example https://inventory.example.com/devices/{id}."
      >
        <Input
          id={`${id}-url`}
          value={value.recordUrl ?? ''}
          autoComplete="off"
          onChange={(e) => onChange({ ...value, recordUrl: e.target.value })}
        />
      </Field>
    </div>
  );
}

export const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  paddingTop: 16,
  borderTop: '1px solid var(--line)',
};

export const headingStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--text)',
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};
