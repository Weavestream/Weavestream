'use client';

import { useState, type ReactNode } from 'react';
import type { IntegrationCompanyMappingDto, IntegrationDto } from '@weavestream/shared';
import { saveBlob } from '../../../../../lib/api';
import { Btn, Icon, Tag } from '../../../../../components/ui';
import { DefinitionEditor } from './definition-editor';
import {
  cleanDefinition,
  draftFromConfig,
  exportFileName,
  planHasChanges,
  type CustomApiDraft,
  type CustomApiSavePlan,
} from './definition-draft';
import { ImportDefinitionDialog } from './import-definition';
import { CustomApiSecretInputs } from './secret-inputs';

/**
 * Credentials tab body for a driver with `capabilities.apiDefinition`
 * (Custom API): import and export, the definition editor, and the
 * credentials for exactly the keys the definition needs. The tab owns
 * the state and the save; `plan` says what the save sends.
 */
export function CustomApiConfig({
  integration,
  mappings,
  draft,
  onDraftChange,
  secret,
  onSecretChange,
  rotate,
  onRotateChange,
  plan,
  secretMask,
  testConnection,
}: {
  integration: IntegrationDto;
  mappings: IntegrationCompanyMappingDto[];
  draft: CustomApiDraft;
  onDraftChange: (next: CustomApiDraft) => void;
  secret: Record<string, unknown>;
  onSecretChange: (next: Record<string, unknown>) => void;
  rotate: boolean;
  onRotateChange: (next: boolean) => void;
  plan: CustomApiSavePlan;
  secretMask: ReactNode;
  testConnection: ReactNode;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const savedMode = (draftFromConfig(integration.config).organizations as { mode?: string } | undefined)?.mode;
  const modeWarning =
    mappings.length > 0 && savedMode && savedMode !== draft.organizations.mode
      ? 'Existing organization mappings use the organization ids of the old mode. Check them on the Organizations tab after you save.'
      : null;
  // Test with the typed bundle when it is complete; otherwise the server
  // uses the saved one (and refuses it for a new host).
  const testSecret = plan.secretPatch.secret;
  const unsavedNote = planHasChanges(plan) ? (
    <p style={noteStyle}>
      Test connection checks the saved definition. Save changes first, or use Test in each section below.
    </p>
  ) : null;

  function exportDefinition() {
    const json = JSON.stringify(cleanDefinition(draft), null, 2);
    saveBlob(new Blob([json], { type: 'application/json' }), exportFileName(integration.name));
  }

  const credentials = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h4 style={headingStyle}>Credentials</h4>
        {secretMask}
      </div>
      {plan.keys.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Tag>not needed</Tag>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            This definition uses no credentials.
            {integration.hasSecret ? ' Saving removes the saved credentials.' : ''}
          </span>
          {testConnection}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Tag tone={integration.hasSecret ? 'ok' : 'warn'}>{integration.hasSecret ? 'configured' : 'missing'}</Tag>
            {!plan.entering && (
              <Btn kind="outline" size="sm" icon={Icon.refresh} onClick={() => onRotateChange(true)}>
                Rotate credentials
              </Btn>
            )}
            {testConnection}
          </div>
          {plan.secretReason && <Tag tone="warn">{plan.secretReason}</Tag>}
          {plan.entering && (
            <>
              <CustomApiSecretInputs idPrefix="ca" keys={plan.keys} values={secret} onChange={onSecretChange} />
              <p style={noteStyle}>
                The values replace the saved credentials as a whole. Enter every one.
              </p>
              {rotate && !plan.secretReason && (
                <div>
                  <Btn
                    kind="ghost"
                    size="sm"
                    onClick={() => {
                      onRotateChange(false);
                      onSecretChange({});
                    }}
                  >
                    Cancel rotation
                  </Btn>
                </div>
              )}
            </>
          )}
        </>
      )}
      {unsavedNote}
    </div>
  );

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ ...headingStyle, fontSize: 14 }}>API definition</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn kind="ghost" size="sm" icon={Icon.upload} onClick={() => setImportOpen(true)}>
            Import definition
          </Btn>
          <Btn kind="ghost" size="sm" icon={Icon.download} onClick={exportDefinition} disabled={plan.issues.size > 0}>
            Export definition
          </Btn>
        </div>
      </div>
      <DefinitionEditor
        value={draft}
        onChange={onDraftChange}
        issues={plan.issues}
        integrationId={integration.id}
        testSecret={testSecret}
        credentials={credentials}
        modeWarning={modeWarning}
      />
      <ImportDefinitionDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={onDraftChange} />
    </section>
  );
}

const noteStyle: React.CSSProperties = { margin: 0, fontSize: 12, color: 'var(--muted)' };

const headingStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 13.5,
  fontWeight: 600,
  letterSpacing: -0.2,
  color: 'var(--text)',
};
