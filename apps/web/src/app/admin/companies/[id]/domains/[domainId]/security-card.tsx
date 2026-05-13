'use client';

import { Panel, Tag } from '../../../../../../components/ui';
import type { DomainCheckDetails } from '../../../../../../lib/server-api';

/**
 * Security posture panel for the v2 domain detail page.
 *
 * Surfaces DNSSEC / CAA / HSTS / HTTP-redirect / TLS-crypto signals —
 * everything the scoring rubric grades that isn't email auth. Only
 * mounted when v2 fields are present.
 */
export function SecurityCard({
  details,
}: {
  details: DomainCheckDetails;
}) {
  return (
    <Panel title="Security posture">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '160px 1fr',
          rowGap: 12,
          columnGap: 16,
          fontSize: 13,
          alignItems: 'start',
        }}
      >
        <Label>DNSSEC</Label>
        <DnssecRow details={details} />

        <Label>CAA records</Label>
        <CaaRow details={details} />

        <Label>HTTP → HTTPS</Label>
        <RedirectRow details={details} />

        <Label>HSTS</Label>
        <HstsRow details={details} />

        <Label>TLS crypto</Label>
        <TlsCryptoRow details={details} />

        <Label>Registry lock</Label>
        <LockRow details={details} />

        <Label>NS match</Label>
        <NsMatchRow details={details} />
      </div>
    </Panel>
  );
}

function DnssecRow({ details }: { details: DomainCheckDetails }) {
  const dnssec = details.dns?.dnssec;
  if (!dnssec) return <Muted>No DNSSEC data</Muted>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Tag tone={dnssec.signed ? 'ok' : 'warn'}>
        {dnssec.signed ? 'Signed' : 'Not signed'}
      </Tag>
      <span style={{ color: 'var(--muted)', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
        source={dnssec.source}
        {typeof dnssec.dsRecordCount === 'number' && dnssec.dsRecordCount > 0
          ? ` · ${dnssec.dsRecordCount} DS`
          : ''}
      </span>
    </div>
  );
}

function CaaRow({ details }: { details: DomainCheckDetails }) {
  const caa = details.dns?.caa ?? [];
  if (caa.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Tag tone="warn">None</Tag>
        <span style={{ color: 'var(--muted)' }}>
          Any CA can issue certificates for this domain.
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div>
        <Tag tone="ok">{caa.length} record{caa.length === 1 ? '' : 's'}</Tag>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {caa.map((rec, idx) => (
          <code
            key={idx}
            style={{
              fontSize: 11.5,
              color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {rec.flag} {rec.tag} "{rec.value}"
          </code>
        ))}
      </div>
    </div>
  );
}

function RedirectRow({ details }: { details: DomainCheckDetails }) {
  const http = details.http;
  if (!http) return <Muted>No HTTP data</Muted>;
  if (http.redirectsToHttps) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Tag tone="ok">Redirects to HTTPS</Tag>
        {http.finalStatus !== null && http.finalStatus !== undefined && (
          <span
            style={{ color: 'var(--muted)', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}
          >
            final {http.finalStatus}
          </span>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Tag tone="warn">No redirect</Tag>
      <span style={{ color: 'var(--muted)' }}>
        Plain HTTP returns content without upgrading.
      </span>
    </div>
  );
}

function HstsRow({ details }: { details: DomainCheckDetails }) {
  const hsts = details.http?.hsts;
  if (!hsts || !hsts.present) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Tag tone="warn">Not set</Tag>
        <span style={{ color: 'var(--muted)' }}>
          No <code>Strict-Transport-Security</code> header.
        </span>
      </div>
    );
  }
  const maxAge = hsts.maxAge ?? 0;
  const maxAgeOk = maxAge >= 15_552_000;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Tag tone={maxAgeOk ? 'ok' : 'warn'}>
        max-age={maxAge}
        {maxAgeOk ? ' (≥180d)' : ' (<180d)'}
      </Tag>
      {hsts.includeSubDomains && <Tag tone="info">includeSubDomains</Tag>}
      {hsts.preload && <Tag tone="info">preload</Tag>}
    </div>
  );
}

function TlsCryptoRow({ details }: { details: DomainCheckDetails }) {
  const cert = details.tls?.cert;
  if (!cert) return <Muted>No TLS metadata</Muted>;
  const keyLabel = `${cert.keyAlgo ?? '?'}${cert.keyBits ? `-${cert.keyBits}` : ''}`;
  const sigOk = !/(sha1|md5)/i.test(cert.sigAlgo ?? '');
  const keyOk =
    (cert.keyAlgo === 'RSA' && (cert.keyBits ?? 0) >= 2048) ||
    (cert.keyAlgo === 'EC' && (cert.keyBits ?? 0) >= 256) ||
    cert.keyAlgo === 'ED25519';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Tag tone={keyOk ? 'ok' : 'warn'}>{keyLabel}</Tag>
      <Tag tone={sigOk ? 'ok' : 'danger'}>{cert.sigAlgo ?? 'unknown sig'}</Tag>
      {cert.mustStaple && <Tag tone="info">must-staple</Tag>}
      {cert.ocspStapled && <Tag tone="info">OCSP stapled</Tag>}
      {typeof cert.daysUntilExpiry === 'number' && (
        <span
          style={{
            color: 'var(--muted)',
            fontSize: 11.5,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {cert.daysUntilExpiry > 0
            ? `${cert.daysUntilExpiry}d until expiry`
            : `expired ${Math.abs(cert.daysUntilExpiry)}d ago`}
        </span>
      )}
    </div>
  );
}

function LockRow({ details }: { details: DomainCheckDetails }) {
  const whois = details.whois;
  if (!whois) return <Muted>No registry data</Muted>;
  if (whois.hold) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Tag tone="danger">On hold</Tag>
        <span style={{ color: 'var(--muted)' }}>
          {(whois.statusCodes ?? []).join(', ') || 'registry-level suspension'}
        </span>
      </div>
    );
  }
  if (whois.locked) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Tag tone="ok">Transfer locked</Tag>
        <span style={{ color: 'var(--muted)', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
          {(whois.statusCodes ?? []).join(', ') || 'clientTransferProhibited'}
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Tag tone="warn">Not locked</Tag>
      <span style={{ color: 'var(--muted)' }}>
        Enable transfer lock in your registrar.
      </span>
    </div>
  );
}

function NsMatchRow({ details }: { details: DomainCheckDetails }) {
  const ns = details.dns?.nsMatch;
  if (!ns) return <Muted>No NS data</Muted>;
  if (ns.match === 'match') {
    return <Tag tone="ok">DNS ↔ Registry match</Tag>;
  }
  if (ns.match === 'unverifiable') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Tag tone="outline">Unverifiable</Tag>
        <span style={{ color: 'var(--muted)' }}>
          Registry did not return NS records.
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Tag tone="danger">Mismatch</Tag>
      <span
        style={{
          color: 'var(--muted)',
          fontSize: 11.5,
          fontFamily: 'var(--font-mono)',
        }}
      >
        DNS: {ns.dnsNs.join(', ') || '—'}
        <br />
        Registry: {ns.whoisNs.join(', ') || '—'}
      </span>
    </div>
  );
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

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--muted)' }}>{children}</span>;
}
