'use client';

import { useState } from 'react';
import {
  entraIssuerForTenant,
  isEntraTenantId,
  problemMessage,
  validateSsoSettings,
  type SsoSettings,
  type SsoSettingsField,
  type SsoTestResult,
} from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  CheckboxOption,
  Field,
  Input,
  Panel,
  Tag,
  useToast,
} from '../../../../components/ui';

const FIELD_LABEL: Record<SsoSettingsField, string> = {
  issuer: 'Issuer URL',
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  allowedTenantId: 'Allowed tenant ID',
};

/**
 * Admin > Settings > Single sign-on. The client secret is write-only: the API
 * only says whether one is set, so this form shows "Secret set" with Replace
 * and Clear and never holds the stored value. When the environment configures
 * SSO (`source: 'env'`) everything is read-only. Saving goes through the
 * shared `apiFetch`, which raises the step-up prompt the API demands.
 */
export function SsoSettingsForm({ initial }: { initial: SsoSettings }) {
  const toast = useToast();
  const [baseline, setBaseline] = useState(initial);
  const readOnly = initial.source === 'env';

  const [enabled, setEnabled] = useState(initial.enabled);
  const [providerName, setProviderName] = useState(initial.providerName);
  const [issuer, setIssuer] = useState(initial.issuer ?? '');
  const [clientId, setClientId] = useState(initial.clientId ?? '');
  const [secretSet, setSecretSet] = useState(initial.clientSecretSet);
  const [replacing, setReplacing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [secret, setSecret] = useState('');
  const [scopes, setScopes] = useState(initial.scopes);
  const [allowedTenantId, setAllowedTenantId] = useState(initial.allowedTenantId ?? '');
  const [linkByEmail, setLinkByEmail] = useState(initial.linkByEmail);
  const [autoProvision, setAutoProvision] = useState(initial.autoProvision);
  const [trustIdpMfa, setTrustIdpMfa] = useState(initial.trustIdpMfa);
  const [localLoginEnabled, setLocalLoginEnabled] = useState(initial.localLoginEnabled);
  const [entraTenant, setEntraTenant] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SsoTestResult | null>(null);

  const b = baseline;
  const dirty =
    enabled !== b.enabled ||
    providerName.trim() !== b.providerName ||
    clean(issuer) !== b.issuer ||
    clean(clientId) !== b.clientId ||
    scopes.trim() !== b.scopes ||
    clean(allowedTenantId) !== b.allowedTenantId ||
    linkByEmail !== b.linkByEmail ||
    autoProvision !== b.autoProvision ||
    trustIdpMfa !== b.trustIdpMfa ||
    localLoginEnabled !== b.localLoginEnabled ||
    secret.length > 0 ||
    clearing;

  const secretPresent = clearing ? false : secret.length > 0 || secretSet;
  const entraTenantValid = isEntraTenantId(entraTenant.trim());

  function useEntraTenant() {
    const tenant = entraTenant.trim();
    setIssuer(entraIssuerForTenant(tenant));
    if (!allowedTenantId.trim()) setAllowedTenantId(tenant);
    setResult(null);
  }

  async function save() {
    setError(null);
    const found = enabled
      ? validateSsoSettings({
          issuer,
          clientId,
          clientSecretPresent: secretPresent,
          allowedTenantId,
        })
      : validateSsoSettings({
          issuer: clean(issuer) ?? 'https://placeholder.invalid',
          clientId: 'x',
          clientSecretPresent: true,
          allowedTenantId,
        }).filter((p) => p.field === 'issuer' || p.field === 'allowedTenantId');
    const messages = found.map((p) => `${FIELD_LABEL[p.field]} ${p.message}`);
    if (!providerName.trim()) messages.push('Provider name is required');
    if (!scopes.trim()) messages.push('Scopes are required');
    setProblems(messages);
    if (messages.length > 0) return;

    const payload: Record<string, unknown> = {
      enabled,
      providerName: providerName.trim(),
      issuer: clean(issuer),
      clientId: clean(clientId),
      scopes: scopes.trim(),
      allowedTenantId: clean(allowedTenantId),
      linkByEmail,
      autoProvision,
      trustIdpMfa,
      localLoginEnabled,
    };
    if (secret) payload.clientSecret = secret;
    if (clearing) payload.clearClientSecret = true;

    setPending(true);
    const res = await apiFetch<SsoSettings>('/settings/sso', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      setError(problemMessage(res.problem) ?? 'Could not save single sign-on settings.');
      return;
    }
    setBaseline(res.data);
    setSecretSet(res.data.clientSecretSet);
    setSecret('');
    setReplacing(false);
    setClearing(false);
    toast.push('Single sign-on settings saved.', 'ok');
  }

  async function testConnection() {
    setError(null);
    setTesting(true);
    setResult(null);
    const typed = clean(issuer);
    // Only send an issuer that differs from the saved one; otherwise the
    // server tests what is saved.
    const body = !readOnly && typed && typed !== baseline.issuer ? { issuer: typed } : {};
    const res = await apiFetch<SsoTestResult>('/settings/sso/test', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setTesting(false);
    if (!res.ok || !res.data) {
      setError(problemMessage(res.problem) ?? 'Could not run the connection test.');
      return;
    }
    setResult(res.data);
  }

  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(initial.callbackUrl);
      toast.push('Callback URL copied.', 'ok');
    } catch {
      toast.push('Could not copy. Select the URL and copy it manually.', 'danger');
    }
  }

  function reset() {
    const r = baseline;
    setEnabled(r.enabled);
    setProviderName(r.providerName);
    setIssuer(r.issuer ?? '');
    setClientId(r.clientId ?? '');
    setSecretSet(r.clientSecretSet);
    setReplacing(false);
    setClearing(false);
    setSecret('');
    setScopes(r.scopes);
    setAllowedTenantId(r.allowedTenantId ?? '');
    setLinkByEmail(r.linkByEmail);
    setAutoProvision(r.autoProvision);
    setTrustIdpMfa(r.trustIdpMfa);
    setLocalLoginEnabled(r.localLoginEnabled);
    setProblems([]);
    setError(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 820 }}>
      {readOnly && (
        <div
          role="status"
          style={{
            padding: 14,
            background: 'var(--panel-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <strong>Managed by environment variables</strong>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            Single sign-on is configured in this deployment&apos;s environment, which takes
            priority over this page. To manage it here instead, remove{' '}
            <code>SSO_OIDC_ISSUER</code> and the other <code>SSO_*</code> variables and restart.
            Values are not shown here; these variables are set:
          </span>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
            {initial.envKeysSet.map((k) => (
              <li key={k}>
                <code>{k}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <CheckboxOption
        label="Enable single sign-on"
        hint="Shows a sign-in button on the login page. Password sign-in keeps working unless you turn it off below."
        checked={enabled}
        onChange={setEnabled}
        disabled={readOnly}
      />

      <Field label="Provider name" htmlFor="sso-provider-name" help='Shown on the button: "Sign in with …".'>
        <Input
          id="sso-provider-name"
          value={providerName}
          onChange={(e) => setProviderName(e.target.value)}
          maxLength={60}
          disabled={readOnly}
        />
      </Field>

      <Field
        label="Issuer URL"
        htmlFor="sso-issuer"
        help="For Microsoft Entra ID: https://login.microsoftonline.com/<tenant id>/v2.0. Multi-tenant endpoints (common, organizations, consumers) are refused."
      >
        <Input
          id="sso-issuer"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
          placeholder="https://login.microsoftonline.com/<tenant id>/v2.0"
          maxLength={2048}
          disabled={readOnly}
        />
      </Field>

      {!readOnly && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 10,
            alignItems: 'end',
            padding: 14,
            background: 'var(--panel-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 6,
          }}
        >
          <Field
            label="Microsoft Entra tenant ID"
            htmlFor="sso-entra-tenant"
            help="Paste your Directory (tenant) ID to fill in the issuer URL (and the allowed tenant ID, if empty)."
          >
            <Input
              id="sso-entra-tenant"
              value={entraTenant}
              onChange={(e) => setEntraTenant(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              maxLength={64}
            />
          </Field>
          <Btn kind="outline" onClick={useEntraTenant} disabled={!entraTenantValid}>
            Use for Entra
          </Btn>
        </div>
      )}

      <Field label="Client ID" htmlFor="sso-client-id" help="Application (client) ID from the provider.">
        <Input
          id="sso-client-id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
          maxLength={255}
          disabled={readOnly}
        />
      </Field>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Client secret</span>
        {secretSet && !replacing && !clearing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Tag tone="ok">Secret set</Tag>
            {!readOnly && (
              <>
                <Btn kind="outline" onClick={() => setReplacing(true)}>
                  Replace
                </Btn>
                <Btn kind="ghost" onClick={() => setClearing(true)}>
                  Clear
                </Btn>
              </>
            )}
          </div>
        ) : clearing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Tag tone="danger">Secret will be removed when you save</Tag>
            <Btn kind="ghost" onClick={() => setClearing(false)}>
              Undo
            </Btn>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input
              id="sso-client-secret"
              aria-label="Client secret value"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="new-password"
              maxLength={1024}
              disabled={readOnly}
              style={{ flex: '1 1 260px' }}
            />
            {replacing && (
              <Btn
                kind="ghost"
                onClick={() => {
                  setReplacing(false);
                  setSecret('');
                }}
              >
                Cancel
              </Btn>
            )}
          </div>
        )}
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Write-only: the saved secret is encrypted and is never shown again. Create it under
          Certificates &amp; secrets at your provider and note its expiry date.
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        <Field label="Scopes" htmlFor="sso-scopes" help="Space separated. The default is right for almost every setup.">
          <Input
            id="sso-scopes"
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            maxLength={500}
            disabled={readOnly}
          />
        </Field>
        <Field
          label="Allowed tenant ID"
          htmlFor="sso-tenant"
          help="Optional extra check: only accept sign-ins from this Entra tenant."
        >
          <Input
            id="sso-tenant"
            value={allowedTenantId}
            onChange={(e) => setAllowedTenantId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            maxLength={64}
            disabled={readOnly}
          />
        </Field>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <CheckboxOption
          label="Link accounts by email"
          hint="The first time someone signs in with SSO, connect them to the existing active user with the same email. Only turn this on if your provider verifies email addresses (a single-tenant Entra directory does)."
          checked={linkByEmail}
          onChange={setLinkByEmail}
          disabled={readOnly}
        />
        <CheckboxOption
          label="Create accounts automatically"
          hint="Someone with no matching user gets a new account with no access until an admin grants it. Off: they see 'no account'."
          checked={autoProvision}
          onChange={setAutoProvision}
          disabled={readOnly}
        />
        <CheckboxOption
          label="Trust the provider's multi-factor sign-in"
          hint="If the provider reports that the person used MFA, skip Weavestream's own two-factor code for that session. Needs the provider to send the amr claim; otherwise Weavestream still asks for its own code."
          checked={trustIdpMfa}
          onChange={setTrustIdpMfa}
          disabled={readOnly}
        />
        <CheckboxOption
          label="Allow password sign-in"
          hint="Turn this off to require SSO for everyone except super admins, who keep password sign-in as a break-glass way in. You can only turn it off after a super admin has signed in with SSO and linked their account."
          checked={localLoginEnabled}
          onChange={setLocalLoginEnabled}
          disabled={readOnly}
        />
        {!localLoginEnabled && !readOnly && (
          <Tag tone="warn" style={{ alignSelf: 'flex-start' }}>
            Everyone except super admins will have to use single sign-on. Keep a super admin&apos;s
            password and two-factor code safe in case the provider is unavailable.
          </Tag>
        )}
      </div>

      <Panel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field
            label="Callback URL"
            htmlFor="sso-callback"
            help="Register this exactly as a Web redirect URI at your provider. Weavestream cannot check that it is registered."
          >
            <div style={{ display: 'flex', gap: 10 }}>
              <Input
                id="sso-callback"
                value={initial.callbackUrl}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
                style={{ flex: 1 }}
              />
              <Btn kind="outline" onClick={copyCallback}>
                Copy
              </Btn>
            </div>
          </Field>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Btn kind="outline" onClick={testConnection} loading={testing} disabled={!issuer.trim()}>
              Test connection
            </Btn>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Checks the issuer&apos;s discovery document and signing keys. It does not sign anyone in.
            </span>
          </div>
          {result && (
            <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Tag tone={result.ok ? 'ok' : 'danger'} style={{ alignSelf: 'flex-start' }}>
                {result.ok ? 'Connection OK' : 'Connection failed'}
              </Tag>
              <span style={{ fontSize: 12.5 }}>{result.message}</span>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                <li>Discovery document: {result.discoveryReachable ? 'reachable' : 'not reachable'}</li>
                {result.issuerMatches !== null && (
                  <li>Issuer matches: {result.issuerMatches ? 'yes' : 'no'}</li>
                )}
                {result.authorizationEndpoint && <li>Authorization endpoint: {result.authorizationEndpoint}</li>}
                {result.tokenEndpoint && <li>Token endpoint: {result.tokenEndpoint}</li>}
                {result.jwksUri && <li>Signing keys: {result.jwksReachable ? 'reachable' : 'not reachable'}</li>}
              </ul>
            </div>
          )}
        </div>
      </Panel>

      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Setup checklist</summary>
        <ol style={{ fontSize: 12.5, lineHeight: 1.6, paddingLeft: 20 }}>
          <li>At your provider, register a new web application (single tenant for Microsoft Entra).</li>
          <li>Add the Callback URL above as a redirect URI.</li>
          <li>Create a client secret and paste it here with the client ID and issuer.</li>
          <li>
            Optional claims (Entra: Token configuration): <code>email</code>, <code>xms_edov</code>{' '}
            and <code>auth_time</code>.
          </li>
          <li>Save, then use Test connection.</li>
          <li>Sign in with SSO, then link your own account from My account.</li>
        </ol>
      </details>

      {problems.length > 0 && (
        <ul role="alert" style={{ margin: 0, paddingLeft: 18, color: 'var(--danger)', fontSize: 12.5 }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && (
        <Tag tone="danger" style={{ alignSelf: 'flex-start' }}>
          {error}
        </Tag>
      )}

      {!readOnly && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            borderTop: '1px solid var(--line)',
            paddingTop: 16,
            flexWrap: 'wrap',
          }}
        >
          <Btn kind="ghost" onClick={reset} disabled={!dirty || pending}>
            Reset
          </Btn>
          <Btn kind="primary" onClick={save} loading={pending} disabled={!dirty}>
            Save single sign-on settings
          </Btn>
        </div>
      )}
    </div>
  );
}

function clean(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
