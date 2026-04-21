import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'Domain' };

import {
  getDomain,
  getMe,
  getSettings,
  listDomainChecks,
  serverApiFetch,
  type CompanyDetail,
  type DomainCheck,
} from '../../../../../../lib/server-api';
import { canManage } from '../../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';
import { DomainActions } from './domain-actions';
import { StatusPill } from '../domains-browser';

/**
 * Phase 8 — Admin domain detail. Shows the denormalized latest state
 * on top and the last ~30 rows from `domain_checks` as an append-only
 * audit of every WHOIS / DNS / TLS check we've run.
 */
export default async function DomainDetailPage({
  params,
}: {
  params: Promise<{ id: string; domainId: string }>;
}) {
  const { id: companyId, domainId } = await params;
  const me = (await getMe())!;
  const term = buildTerm(await getSettings());

  const [companyRes, domain, checks] = await Promise.all([
    serverApiFetch<CompanyDetail>(`/companies/${companyId}`),
    getDomain(companyId, domainId),
    listDomainChecks(companyId, domainId, 30),
  ]);
  if (!companyRes.ok || !companyRes.data) notFound();
  if (!domain) notFound();
  const company = companyRes.data;

  const manage = canManage(me.role);

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(
          term,
          company,
          { label: 'Domains', href: `/admin/companies/${companyId}/domains` },
          { label: domain.hostname },
        )}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {domain.hostname}
            <StatusPill status={domain.latestStatus} />
            {domain.visibleToClients ? (
              <Tag tone="accent">client-visible</Tag>
            ) : (
              <Tag tone="outline">internal</Tag>
            )}
            {domain.archivedAt && <Tag tone="warn">archived</Tag>}
          </span>
        }
      />
      <PageBody>
        {manage && (
          <DomainActions
            companyId={companyId}
            domain={domain}
          />
        )}

        <Panel title="Summary">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 16,
            }}
          >
            <Stat
              label="WHOIS expires"
              value={fmtDate(domain.whoisExpiresAt)}
              sub={fmtRelativeFuture(domain.whoisExpiresAt)}
            />
            <Stat
              label="TLS expires"
              value={fmtDate(domain.tlsExpiresAt)}
              sub={fmtRelativeFuture(domain.tlsExpiresAt)}
            />
            <Stat
              label="Alert threshold"
              value={`${domain.alertThresholdDays} days`}
            />
            <Stat
              label="Last checked"
              value={fmtRelativePast(domain.lastCheckedAt) ?? 'never'}
              sub={domain.lastCheckedAt ? fmtDateTime(domain.lastCheckedAt) : undefined}
            />
            <Stat
              label="Checks enabled"
              value={
                [
                  domain.checkWhois && 'WHOIS',
                  domain.checkDns && 'DNS',
                  domain.checkTls && 'TLS',
                ]
                  .filter(Boolean)
                  .join(' · ') || 'none'
              }
            />
          </div>
        </Panel>

        <Panel title="Check history" noPad>
          {checks.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              No checks have been run yet.
            </div>
          ) : (
            <HistoryTable checks={checks} />
          )}
        </Panel>
      </PageBody>
    </>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: 0.3,
          color: 'var(--dim)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 15, color: 'var(--text)' }}>{value}</span>
      {sub && (
        <span
          style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}
        >
          {sub}
        </span>
      )}
    </div>
  );
}

function HistoryTable({ checks }: { checks: DomainCheck[] }) {
  return (
    <>
      <div className="hide-on-mobile" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--dim)' }}>
              <th style={thStyle}>Checked</th>
              <th style={thStyle}>WHOIS</th>
              <th style={thStyle}>DNS</th>
              <th style={thStyle}>TLS</th>
              <th style={thStyle}>WHOIS expiry</th>
              <th style={thStyle}>TLS expiry</th>
              <th style={thStyle}>Note</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.id} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={monoCell}>{fmtDateTime(c.checkedAt)}</td>
                <td style={tdStyle}>
                  <SubStatus status={c.whoisStatus} />
                </td>
                <td style={tdStyle}>
                  <SubStatus status={c.dnsStatus} />
                </td>
                <td style={tdStyle}>
                  <SubStatus status={c.tlsStatus} />
                </td>
                <td style={monoCell}>{fmtDate(c.whoisExpiresAt)}</td>
                <td style={monoCell}>{fmtDate(c.tlsExpiresAt)}</td>
                <td style={{ ...tdStyle, color: 'var(--muted)' }}>
                  {c.error ?? summarize(c.details)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul
        className="mobile-only"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {checks.map((c) => (
          <li
            key={c.id}
            style={{
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: 12,
              background: 'var(--panel)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: 'var(--dim)',
              }}
            >
              {fmtDateTime(c.checkedAt)}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--dim)',
                  marginRight: 2,
                }}
              >
                WHOIS
              </span>
              <SubStatus status={c.whoisStatus} />
              <span
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--dim)',
                  marginLeft: 6,
                  marginRight: 2,
                }}
              >
                DNS
              </span>
              <SubStatus status={c.dnsStatus} />
              <span
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--dim)',
                  marginLeft: 6,
                  marginRight: 2,
                }}
              >
                TLS
              </span>
              <SubStatus status={c.tlsStatus} />
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 6,
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: 'var(--muted)',
              }}
            >
              <span>WHOIS {fmtDate(c.whoisExpiresAt)}</span>
              <span>TLS {fmtDate(c.tlsExpiresAt)}</span>
            </div>
            {(c.error || summarize(c.details)) && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {c.error ?? summarize(c.details)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function SubStatus({ status }: { status: DomainCheck['whoisStatus'] }) {
  if (!status) return <Tag tone="outline">—</Tag>;
  switch (status) {
    case 'OK':
      return <Tag tone="ok">OK</Tag>;
    case 'WARN':
      return <Tag tone="warn">Warn</Tag>;
    case 'FAIL':
      return <Tag tone="danger">Fail</Tag>;
    case 'SKIP':
      return <Tag tone="outline">Skip</Tag>;
  }
}

function summarize(details: Record<string, unknown>): string {
  const parts: string[] = [];
  const whois = details.whois as { registrar?: string } | undefined;
  if (whois?.registrar) parts.push(`registrar=${whois.registrar}`);
  const tls = details.tls as { issuer?: string } | undefined;
  if (tls?.issuer) parts.push(`issuer=${tls.issuer}`);
  const dns = details.dns as { a?: string[]; mx?: string[] } | undefined;
  if (dns?.a && dns.a.length > 0) parts.push(`A=${dns.a.length}`);
  if (dns?.mx && dns.mx.length > 0) parts.push(`MX=${dns.mx.length}`);
  return parts.join(' · ');
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 10);
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function fmtRelativePast(iso: string | null): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} d ago`;
}

function fmtRelativeFuture(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const diff = new Date(iso).getTime() - Date.now();
  const days = Math.round(diff / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'expires today';
  if (days < 30) return `in ${days}d`;
  if (days < 365) return `in ${Math.round(days / 30)} months`;
  return `in ${Math.round(days / 365)} years`;
}

const thStyle: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  borderBottom: '1px solid var(--line)',
};
const tdStyle: React.CSSProperties = { padding: '10px 14px', verticalAlign: 'middle' };
const monoCell: React.CSSProperties = {
  ...tdStyle,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--muted)',
};
