'use client';

import { useRef, useState, type ReactNode } from 'react';
import {
  CUSTOM_API_LIMITS,
  type CustomApiHeader,
  type CustomApiTestKey,
  type CustomApiTestRecord,
} from '@weavestream/shared';
import { Btn, Checkbox, Field, Icon, Input, RadioOption, Tag } from '../../../../../components/ui';
import { AuthFields, fieldsetStyle, legendStyle } from './auth-fields';
import {
  emptyOrganizations,
  emptyResource,
  type CustomApiDraft,
  type DraftIssues,
  type DraftResource,
} from './definition-draft';
import { PathInput, PathTargetProvider, sampleFor } from './path-input';
import { PaginationFields, RequestFields, errorTextStyle, rowStyle } from './request-fields';
import { ResourceSection, headingStyle, sectionStyle } from './resource-section';
import { TestPanel } from './test-panel';

type OrgMode = CustomApiDraft['organizations']['mode'];

const ORG_MODES: Array<{ value: OrgMode; label: string; hint: string }> = [
  { value: 'endpoint', label: 'From an endpoint', hint: 'A request lists the organizations.' },
  { value: 'field', label: 'From a field on each record', hint: 'Each record carries its organization id.' },
  { value: 'single', label: 'One organization', hint: 'All records go to one company.' },
];

/**
 * The API definition editor (Credentials tab of a Custom API integration).
 * Sections: Connection, Authentication, Headers, Organizations, Items. `credentials` renders the secret inputs after Headers,
 * because secret headers add secret keys. Every value is validated with
 * the shared schema by the caller (`issues`).
 */
export function DefinitionEditor({
  value,
  onChange,
  issues,
  integrationId,
  testSecret,
  credentials,
  modeWarning,
}: {
  value: CustomApiDraft;
  onChange: (next: CustomApiDraft) => void;
  issues: DraftIssues;
  integrationId: string | null;
  /** The secret bundle a Test sends; omitted means the saved secret. */
  testSecret?: Record<string, string>;
  credentials: ReactNode;
  /** Shown under the organization mode, for example when mappings use the old mode. */
  modeWarning?: string | null;
}) {
  // Items turned off keeps its settings for this session, so turning it
  // back on does not lose the admin's paths.
  const stash = useRef<DraftResource | null>(null);
  const [orgResult, setOrgResult] = useState<{ records: CustomApiTestRecord[]; keys: CustomApiTestKey[] } | null>(null);
  const testDisabledReason =
    issues.size > 0 ? 'Fix the problems in the definition, then test.' : null;
  const headers = value.headers ?? [];
  const orgs = value.organizations;

  const setItems = (next: DraftResource | { enabled: false }) =>
    onChange({ ...value, resources: { ...value.resources, items: next } });
  const toggleItems = (enabled: boolean) => {
    const current = value.resources.items;
    if (enabled) {
      setItems(stash.current ?? emptyResource());
    } else {
      if (current?.enabled) stash.current = current;
      setItems({ enabled: false });
    }
  };

  return (
    <PathTargetProvider>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {issues.get('') && <Tag tone="danger">{issues.get('')}</Tag>}

        <section style={{ ...sectionStyle, borderTop: 0, paddingTop: 0 }}>
          <h4 style={headingStyle}>Connection</h4>
          <Field
            label="Base URL"
            htmlFor="ca-base-url"
            error={issues.get('baseUrl')}
            help="HTTPS. A path prefix is allowed, for example https://inventory.example.com/api."
          >
            <Input
              id="ca-base-url"
              type="url"
              value={value.baseUrl}
              autoComplete="off"
              onChange={(e) => onChange({ ...value, baseUrl: e.target.value })}
            />
          </Field>
        </section>

        <section style={sectionStyle}>
          <h4 style={headingStyle}>Authentication</h4>
          <AuthFields idPrefix="ca" value={value.auth} onChange={(auth) => onChange({ ...value, auth })} issues={issues} />
        </section>

        <section style={sectionStyle}>
          <h4 style={headingStyle}>Headers</h4>
          <HeadersFields headers={headers} onChange={(next) => onChange({ ...value, headers: next })} issues={issues} />
        </section>

        <section style={sectionStyle}>{credentials}</section>

        <section style={sectionStyle} aria-labelledby="ca-orgs-title">
          <h4 id="ca-orgs-title" style={headingStyle}>Organizations</h4>
          <fieldset style={fieldsetStyle}>
            <legend style={legendStyle}>Where the organizations come from</legend>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
              {ORG_MODES.map((m) => (
                <RadioOption
                  key={m.value}
                  name="ca-org-mode"
                  checked={orgs.mode === m.value}
                  onChange={() => {
                    if (orgs.mode !== m.value) onChange({ ...value, organizations: emptyOrganizations(m.value) });
                  }}
                  label={m.label}
                  hint={m.hint}
                />
              ))}
            </div>
          </fieldset>
          {modeWarning && <Tag tone="warn">{modeWarning}</Tag>}
          {orgs.mode === 'endpoint' && (
            <>
              <RequestFields
                idPrefix="ca-orgs-request"
                issuePath="organizations.request"
                value={orgs.request}
                onChange={(request) => onChange({ ...value, organizations: { ...orgs, request } })}
                issues={issues}
              />
              <PathInput
                id="ca-orgs-records"
                label="Records path"
                value={orgs.recordsPath ?? ''}
                error={issues.get('organizations.recordsPath')}
                help="Where the response holds the list. Empty: the response is the list."
                onChange={(recordsPath) => onChange({ ...value, organizations: { ...orgs, recordsPath } })}
              />
              <PaginationFields
                idPrefix="ca-orgs-pages"
                issuePath="organizations.pagination"
                value={orgs.pagination ?? { style: 'none' }}
                onChange={(pagination) => onChange({ ...value, organizations: { ...orgs, pagination } })}
                issues={issues}
              />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <PathInput
                  id="ca-orgs-id"
                  label="Id path"
                  value={orgs.idPath}
                  error={issues.get('organizations.idPath')}
                  sample={sampleFor(orgResult?.keys, orgs.idPath)}
                  onChange={(idPath) => onChange({ ...value, organizations: { ...orgs, idPath } })}
                />
                <PathInput
                  id="ca-orgs-name"
                  label="Name path"
                  value={orgs.namePath}
                  error={issues.get('organizations.namePath')}
                  sample={sampleFor(orgResult?.keys, orgs.namePath)}
                  onChange={(namePath) => onChange({ ...value, organizations: { ...orgs, namePath } })}
                />
              </div>
            </>
          )}
          {orgs.mode === 'field' && (
            <p style={helpStyle}>Set the organization id path under Items below. Test reads the first page of Items.</p>
          )}
          {orgs.mode === 'single' && (
            <p style={helpStyle}>Every record belongs to one organization, “All records”. Map it to a company on the Organizations tab.</p>
          )}
          <TestPanel
            integrationId={integrationId}
            definition={value}
            section="organizations"
            secret={testSecret}
            disabledReason={testDisabledReason}
            onResult={(result) => setOrgResult(result?.ok ? { records: result.records, keys: result.keys } : null)}
          />
        </section>

        <ResourceSection
          value={(value.resources.items ?? { enabled: false }) as DraftResource | { enabled: false }}
          onToggle={toggleItems}
          onChange={setItems}
          issues={issues}
          definition={value}
          organizations={orgResult?.records ?? []}
          integrationId={integrationId}
          testSecret={testSecret}
          testDisabledReason={testDisabledReason}
        />
      </div>
    </PathTargetProvider>
  );
}

function HeadersFields({
  headers,
  onChange,
  issues,
}: {
  headers: CustomApiHeader[];
  onChange: (next: CustomApiHeader[]) => void;
  issues: DraftIssues;
}) {
  const set = (index: number, next: CustomApiHeader) => onChange(headers.map((h, i) => (i === index ? next : h)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {headers.length === 0 && <p style={helpStyle}>No extra headers. Authentication sets its own header.</p>}
      {headers.map((header, index) => {
        const secret = 'secret' in header;
        const error = issues.get(`headers.${index}.name`) ?? issues.get(`headers.${index}.value`) ?? issues.get(`headers.${index}`);
        return (
          <div key={index} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ ...rowStyle, alignItems: 'center' }}>
              <Input
                aria-label={`Header ${index + 1} name`}
                value={header.name}
                placeholder="Accept"
                autoComplete="off"
                style={{ flex: '1 1 160px', fontFamily: 'var(--font-mono)' }}
                onChange={(e) => set(index, { ...header, name: e.target.value })}
              />
              {secret ? (
                <span style={{ flex: '2 1 200px', fontSize: 12, color: 'var(--muted)' }}>Value entered under Credentials.</span>
              ) : (
                <Input
                  aria-label={`Header ${index + 1} value`}
                  value={header.value}
                  placeholder="application/json"
                  autoComplete="off"
                  style={{ flex: '2 1 200px' }}
                  onChange={(e) => set(index, { name: header.name, value: e.target.value })}
                />
              )}
              <Checkbox
                label="Secret"
                checked={secret}
                onChange={(next) => set(index, next ? { name: header.name, secret: true } : { name: header.name, value: '' })}
              />
              <Btn
                kind="ghost"
                size="sm"
                icon={Icon.trash}
                aria-label={`Remove header ${index + 1}`}
                onClick={() => onChange(headers.filter((_, i) => i !== index))}
              />
            </div>
            {error && <span role="alert" style={errorTextStyle}>{error}</span>}
          </div>
        );
      })}
      <div>
        <Btn
          kind="ghost"
          size="sm"
          icon={Icon.plus}
          disabled={headers.length >= CUSTOM_API_LIMITS.headers}
          onClick={() => onChange([...headers, { name: '', value: '' }])}
        >
          Add header
        </Btn>
      </div>
    </div>
  );
}

const helpStyle: React.CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--muted)' };
