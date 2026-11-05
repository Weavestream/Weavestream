'use client';

import { useMemo, useState } from 'react';
import { Btn, Field, Icon, Input, Tag } from '../../../../../components/ui';
import { AuthFields } from './auth-fields';
import {
  createTestSection,
  issuesOf,
  newDefinition,
  secretBundle,
  secretKeysFor,
  type CustomApiDraft,
} from './definition-draft';
import { ImportDefinitionForm } from './import-definition';
import { PathTargetProvider } from './path-input';
import { CustomApiSecretInputs } from './secret-inputs';
import { TestPanel } from './test-panel';

/**
 * Create-dialog fields for a Custom API integration: Base URL,
 * authentication and its credentials. The rest of the definition is
 * completed on the Credentials tab. Importing a definition is a
 * secondary path; only an imported definition can be tested here.
 */
export function CustomApiCreateFields({
  draft,
  onDraftChange,
  secret,
  onSecretChange,
  imported,
  onImportedChange,
}: {
  draft: CustomApiDraft;
  onDraftChange: (next: CustomApiDraft) => void;
  secret: Record<string, unknown>;
  onSecretChange: (next: Record<string, unknown>) => void;
  imported: boolean;
  onImportedChange: (next: boolean) => void;
}) {
  const [importing, setImporting] = useState(false);
  const issues = useMemo(() => issuesOf(draft), [draft]);
  const keys = secretKeysFor(draft);
  const testSection = imported ? createTestSection(draft) : null;
  const bundle = secretBundle(keys, secret);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field
        label="Base URL"
        htmlFor="ca-new-base-url"
        error={draft.baseUrl ? issues.get('baseUrl') : undefined}
        help="HTTPS. A path prefix is allowed, for example https://inventory.example.com/api."
      >
        <Input
          id="ca-new-base-url"
          type="url"
          value={draft.baseUrl}
          autoComplete="off"
          onChange={(e) => onDraftChange({ ...draft, baseUrl: e.target.value })}
        />
      </Field>
      <AuthFields idPrefix="ca-new" value={draft.auth} onChange={(auth) => onDraftChange({ ...draft, auth })} issues={issues} dense />
      <CustomApiSecretInputs idPrefix="ca-new" keys={keys} values={secret} onChange={onSecretChange} />

      {imported ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Tag tone="ok">Definition imported</Tag>
          <Btn
            kind="ghost"
            size="sm"
            onClick={() => {
              onImportedChange(false);
              onDraftChange(newDefinition(draft.baseUrl, draft.auth));
            }}
          >
            Remove
          </Btn>
        </div>
      ) : importing ? (
        <ImportDefinitionForm
          onCancel={() => setImporting(false)}
          onImport={(definition) => {
            setImporting(false);
            onImportedChange(true);
            onDraftChange(definition);
          }}
        />
      ) : (
        <div>
          <Btn kind="ghost" size="sm" icon={Icon.upload} onClick={() => setImporting(true)}>
            Import definition…
          </Btn>
        </div>
      )}
      {imported && issues.size > 0 && (
        <Tag tone="danger">Fix the Base URL and authentication above before you test or create.</Tag>
      )}
      {testSection && (
        <PathTargetProvider>
          <TestPanel
            integrationId={null}
            definition={draft}
            section={testSection}
            secret={Object.keys(bundle).length > 0 ? bundle : undefined}
            disabledReason={
              issues.size > 0
                ? 'Fix the problems above, then test.'
                : keys.length > 0 && Object.keys(bundle).length < keys.length
                  ? 'Enter the credentials, then test.'
                  : null
            }
          />
        </PathTargetProvider>
      )}
      {imported && !testSection && (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          Turn on a resource on the Credentials tab to test this definition.
        </span>
      )}
    </div>
  );
}
