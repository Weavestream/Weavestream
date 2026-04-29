import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'Domain' };

import {
  getCompanyDetail,
  getDomain,
  getMe,
  getSettings,
  listDomainChecks,
  throwUnlessFound,
} from '../../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';
import { DomainActions } from './domain-actions';
import { DomainHistory } from './domain-history';
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
    getCompanyDetail(companyId),
    getDomain(companyId, domainId),
    listDomainChecks(companyId, domainId, 30),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);
  if (!domain) notFound();

  const manage = canWriteCompany(me, company.id);

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
            <DomainHistory checks={checks} />
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
