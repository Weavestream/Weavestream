'use client';

import { Panel, Tag } from '../../../../../../components/ui';
import type { DomainCheckDetails } from '../../../../../../lib/server-api';

/**
 * Email authentication panel for the v2 domain detail page.
 *
 * Renders SPF / DMARC / DKIM evidence as plain rows — no graph, no
 * chart — because the operator needs to read the raw record string to
 * fix it. Only mounted when v2 data is present (callers gate on
 * `details.email`).
 */
export function EmailAuthCard({
  details,
}: {
  details: DomainCheckDetails;
}) {
  const email = details.email;
  if (!email) return null;

  if (!email.hasMx) {
    return (
      <Panel title="Email authentication">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
            color: 'var(--muted)',
          }}
        >
          <Tag tone="outline">No MX</Tag>
          <span>
            This domain has no MX records. SPF / DMARC / DKIM checks are
            skipped — the score is calculated without penalising mail
            signals.
          </span>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Email authentication">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '120px 1fr',
          rowGap: 12,
          columnGap: 16,
          fontSize: 13,
          alignItems: 'start',
        }}
      >
        <Label>SPF</Label>
        <SpfRow email={email} />

        <Label>DMARC</Label>
        <DmarcRow email={email} />

        <Label>DKIM</Label>
        <DkimRow email={email} />
      </div>
    </Panel>
  );
}

function SpfRow({ email }: { email: NonNullable<DomainCheckDetails['email']> }) {
  const spf = email.spf;
  if (!spf || !spf.present) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Tag tone="danger">Not configured</Tag>
        <span style={{ color: 'var(--muted)' }}>
          No <code>v=spf1</code> record at the apex.
        </span>
      </div>
    );
  }
  const allTone =
    spf.all === '-all'
      ? 'ok'
      : spf.all === '~all'
        ? 'warn'
        : 'danger';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Tag tone={spf.valid ? 'ok' : 'warn'}>
          {spf.valid ? 'Valid' : 'Invalid'}
        </Tag>
        {spf.all && <Tag tone={allTone}>{spf.all}</Tag>}
        {typeof spf.lookupCount === 'number' && (
          <Tag tone={spf.lookupCount > 10 ? 'danger' : 'outline'}>
            {spf.lookupCount}/10 lookups
          </Tag>
        )}
      </div>
      <code
        style={{
          fontSize: 11.5,
          color: 'var(--muted)',
          background: 'var(--panel-2)',
          padding: '6px 8px',
          borderRadius: 4,
          wordBreak: 'break-all',
        }}
      >
        {spf.record ?? '—'}
      </code>
    </div>
  );
}

function DmarcRow({ email }: { email: NonNullable<DomainCheckDetails['email']> }) {
  const dmarc = email.dmarc;
  if (!dmarc || !dmarc.present) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Tag tone="danger">Not configured</Tag>
        <span style={{ color: 'var(--muted)' }}>
          No <code>_dmarc.&lt;host&gt;</code> TXT record.
        </span>
      </div>
    );
  }
  const policyTone =
    dmarc.policy === 'reject'
      ? 'ok'
      : dmarc.policy === 'quarantine'
        ? 'warn'
        : 'danger';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Tag tone={policyTone}>p={dmarc.policy ?? 'none'}</Tag>
        {dmarc.subdomainPolicy && (
          <Tag tone="outline">sp={dmarc.subdomainPolicy}</Tag>
        )}
        {typeof dmarc.pct === 'number' && (
          <Tag tone={dmarc.pct === 100 ? 'outline' : 'warn'}>pct={dmarc.pct}</Tag>
        )}
        {(dmarc.rua?.length ?? 0) > 0 && (
          <Tag tone="info">{dmarc.rua!.length} rua</Tag>
        )}
        {(dmarc.ruf?.length ?? 0) > 0 && (
          <Tag tone="info">{dmarc.ruf!.length} ruf</Tag>
        )}
      </div>
      <code
        style={{
          fontSize: 11.5,
          color: 'var(--muted)',
          background: 'var(--panel-2)',
          padding: '6px 8px',
          borderRadius: 4,
          wordBreak: 'break-all',
        }}
      >
        {dmarc.raw ?? '—'}
      </code>
    </div>
  );
}

function DkimRow({ email }: { email: NonNullable<DomainCheckDetails['email']> }) {
  const dkim = email.dkim;
  if (!dkim || dkim.selectorsChecked.length === 0) {
    return (
      <span style={{ color: 'var(--muted)' }}>No DKIM selectors probed.</span>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {dkim.provider && dkim.provider !== 'unknown' && (
          <Tag tone="accent">{providerLabel(dkim.provider)}</Tag>
        )}
        <Tag tone={dkim.selectorsFound.length > 0 ? 'ok' : 'warn'}>
          {dkim.selectorsFound.length}/{dkim.selectorsChecked.length} found
        </Tag>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
        Probed: {dkim.selectorsChecked.join(', ')}
      </div>
      {dkim.selectorsFound.length > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--ok)', fontFamily: 'var(--font-mono)' }}>
          Found: {dkim.selectorsFound.join(', ')}
        </div>
      )}
      {dkim.selectorsFound.length === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>
          If you use a custom DKIM selector, add it via the domain's
          edit form — DKIM detection is best-effort.
        </div>
      )}
    </div>
  );
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'google':
      return 'Google Workspace';
    case 'microsoft':
      return 'Microsoft 365';
    case 'mailgun':
      return 'Mailgun';
    case 'sendgrid':
      return 'SendGrid';
    default:
      return provider;
  }
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        color: 'var(--dim)',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        paddingTop: 4,
      }}
    >
      {children}
    </span>
  );
}
