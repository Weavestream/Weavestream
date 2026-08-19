'use client';

import { useRef, useState } from 'react';
import type { EmailSettings, SmtpSecurityMode } from '@weavestream/shared';
import { apiFetch } from '../../../../lib/api';
import { Btn, Field, Input, Select, Tag, useToast } from '../../../../components/ui';
import { extractProblemMessage } from '../../../../lib/api-errors';

export function EmailSettingsForm({
  initial,
  defaultRecipient,
}: {
  initial: EmailSettings;
  defaultRecipient: string;
}) {
  const toast = useToast();
  const baseline = useRef(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [host, setHost] = useState(initial.host ?? '');
  const [port, setPort] = useState(initial.port?.toString() ?? '587');
  const [secureMode, setSecureMode] = useState<SmtpSecurityMode>(
    initial.secureMode,
  );
  const [username, setUsername] = useState(initial.username ?? '');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [fromName, setFromName] = useState(initial.fromName ?? '');
  const [fromEmail, setFromEmail] = useState(initial.fromEmail ?? '');
  const [replyTo, setReplyTo] = useState(initial.replyTo ?? '');
  const [testRecipient, setTestRecipient] = useState(defaultRecipient);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    enabled !== baseline.current.enabled ||
    clean(host) !== baseline.current.host ||
    portValue(port) !== baseline.current.port ||
    secureMode !== baseline.current.secureMode ||
    clean(username) !== baseline.current.username ||
    clean(fromName) !== baseline.current.fromName ||
    clean(fromEmail) !== baseline.current.fromEmail ||
    clean(replyTo) !== baseline.current.replyTo ||
    password.length > 0 ||
    clearPassword;

  async function save() {
    setError(null);
    setPending(true);
    const payload: Record<string, unknown> = {
      enabled,
      host: clean(host),
      port: portValue(port),
      secureMode,
      username: clean(username),
      fromName: clean(fromName),
      fromEmail: clean(fromEmail),
      replyTo: clean(replyTo),
    };
    if (password) payload.password = password;
    if (clearPassword) payload.clearPassword = true;

    const res = await apiFetch<EmailSettings>('/settings/email', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    setPending(false);
    if (!res.ok || !res.data) {
      setError(extractProblemMessage(res.problem) ?? 'Could not save email settings.');
      return;
    }
    baseline.current = res.data;
    setPassword('');
    setClearPassword(false);
    toast.push('Email settings saved.', 'ok');
  }

  async function sendTest() {
    setError(null);
    setTesting(true);
    const res = await apiFetch<{ ok: true }>('/settings/email/test', {
      method: 'POST',
      body: JSON.stringify({ recipient: testRecipient.trim() }),
    });
    setTesting(false);
    if (!res.ok) {
      setError(extractProblemMessage(res.problem) ?? 'Could not send test email.');
      return;
    }
    toast.push('Test email sent.', 'ok');
  }

  function reset() {
    const b = baseline.current;
    setEnabled(b.enabled);
    setHost(b.host ?? '');
    setPort(b.port?.toString() ?? '587');
    setSecureMode(b.secureMode);
    setUsername(b.username ?? '');
    setPassword('');
    setClearPassword(false);
    setFromName(b.fromName ?? '');
    setFromEmail(b.fromEmail ?? '');
    setReplyTo(b.replyTo ?? '');
    setError(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: 'var(--text)',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable outbound email
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 16 }}>
        <Field label="SMTP host" htmlFor="smtp-host">
          <Input
            id="smtp-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.example.com"
            maxLength={255}
          />
        </Field>
        <Field label="Port" htmlFor="smtp-port">
          <Input
            id="smtp-port"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </Field>
        <Field label="Security" htmlFor="smtp-security">
          <Select
            id="smtp-security"
            value={secureMode}
            onChange={(e) => setSecureMode(e.target.value as SmtpSecurityMode)}
          >
            <option value="STARTTLS">STARTTLS</option>
            <option value="TLS">TLS</option>
            <option value="NONE">None</option>
          </Select>
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Field label="Username" htmlFor="smtp-user">
          <Input
            id="smtp-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            maxLength={255}
          />
        </Field>
        <Field
          label="Password"
          htmlFor="smtp-password"
          help={
            baseline.current.passwordConfigured
              ? 'Password is configured. Enter a new value to replace it.'
              : 'Required when your SMTP server uses username/password auth.'
          }
        >
          <Input
            id="smtp-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            maxLength={1024}
            placeholder={baseline.current.passwordConfigured ? 'Configured' : ''}
          />
        </Field>
      </div>

      {baseline.current.passwordConfigured && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: 'var(--text-2)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={clearPassword}
            disabled={password.length > 0}
            onChange={(e) => setClearPassword(e.target.checked)}
          />
          Clear saved SMTP password
        </label>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <Field label="From name" htmlFor="smtp-from-name">
          <Input
            id="smtp-from-name"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="Weavestream"
            maxLength={120}
          />
        </Field>
        <Field label="From email" htmlFor="smtp-from-email">
          <Input
            id="smtp-from-email"
            type="email"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            placeholder="noreply@example.com"
            maxLength={255}
          />
        </Field>
        <Field label="Reply-to" htmlFor="smtp-reply-to">
          <Input
            id="smtp-reply-to"
            type="email"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            placeholder="support@example.com"
            maxLength={255}
          />
        </Field>
      </div>

      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 14,
          background: 'var(--panel-2)',
          border: '1px solid var(--line-2)',
          borderRadius: 6,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 10,
            alignItems: 'end',
          }}
        >
          <Field label="Test recipient" htmlFor="smtp-test-recipient">
            <Input
              id="smtp-test-recipient"
              type="email"
              value={testRecipient}
              onChange={(e) => setTestRecipient(e.target.value)}
              maxLength={255}
            />
          </Field>
          <Btn
            kind="outline"
            onClick={sendTest}
            loading={testing}
            disabled={dirty || !testRecipient.trim()}
          >
            Send test email
          </Btn>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          {dirty
            ? 'Save changes before sending a test email; tests use persisted settings.'
            : 'Sends a simple test email using the saved SMTP configuration.'}
        </div>
      </section>

      {error && (
        <Tag tone="danger" style={{ alignSelf: 'flex-start' }}>
          {error}
        </Tag>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 10,
          borderTop: '1px solid var(--line)',
          paddingTop: 16,
        }}
      >
        <Btn kind="ghost" onClick={reset} disabled={!dirty || pending}>
          Reset
        </Btn>
        <Btn
          kind="primary"
          onClick={save}
          loading={pending}
          disabled={!dirty}
        >
          Save email settings
        </Btn>
      </div>
    </div>
  );
}

function clean(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function portValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
