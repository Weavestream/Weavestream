import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import type { MembershipRole } from '@weavestream/shared';
import {
  getMe,
  getSettings,
  listAssets,
  listDomains,
  serverApiFetch,
  type CompanyDetail,
  type MonitoredDomain,
} from '../../../../lib/server-api';
import {
  canManage,
  canManageCompanyMemberships,
} from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import {
  CompanyAvatar,
  ErrorBanner,
  Icon,
  LayoutSwatch,
  Panel,
  Tag,
} from '../../../../components/ui';
import { buildTerm } from '../../../../lib/term';
import {
  buildMapsUrl,
  companyAccent,
  companyTypeLabel,
  companyTypeTone,
  formatAddressLines,
} from '../../../../lib/company-format';
import { CompanyActions } from './company-actions';
import { CompanyMemberships } from './company-memberships';

type MembershipListing = {
  id: string;
  role: MembershipRole;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    isActive: boolean;
    mfaEnabled: boolean;
  };
};

/**
 * Company "home" / glance overview. Phase 9a layout:
 *
 *   Quick links row (Assets / Articles / Photos / Domains)
 *   → Contact / Address / Classification panels (3-up)
 *   → Domain alert banner (only when something is actually failing)
 *   → Recent assets + Memberships
 *
 * Editing all the expanded fields happens on the dedicated
 * `/admin/companies/:id/settings` page — keeps this one scannable.
 */
export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = (await getMe())!;
  const term = buildTerm(await getSettings());

  const [companyRes, membershipsRes, assetsPage, domainPage] =
    await Promise.all([
      serverApiFetch<CompanyDetail>(`/companies/${id}`),
      serverApiFetch<MembershipListing[]>(`/companies/${id}/memberships`),
      listAssets(id, { limit: 5 }),
      listDomains(id, { limit: 200 }),
    ]);
  if (!companyRes.ok || !companyRes.data) notFound();
  const company = companyRes.data;
  const memberships = membershipsRes.data ?? [];
  const membershipsError = !membershipsRes.ok ? membershipsRes : null;
  const recentAssets = assetsPage.items;
  const domains = domainPage.items;
  // Global-role gate for editing the company itself (archive, edit in
  // Settings, etc.). Memberships have a stricter per-company rule, see
  // below.
  const manage = canManage(me.role);
  const manageMemberships = canManageCompanyMemberships(me, company.id);
  const accent = companyAccent(company.id);
  const logoUrl = company.logo?.url ?? company.logo?.thumbnailUrl ?? null;

  return (
    <>
      <PageHeader
        crumbs={[
          { label: term.other, href: '/admin/companies' },
          { label: company.name },
        ]}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
            <CompanyAvatar
              name={company.name}
              color={accent}
              size={32}
              logoUrl={logoUrl}
            />
            <span>{company.name}</span>
          </span>
        }
        description={<HeaderMeta company={company} />}
        actions={manage ? <CompanyActions company={company} /> : null}
      />
      <PageBody>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 10,
          }}
        >
          <QuickLink
            href={`/admin/companies/${company.id}/assets`}
            icon={<Icon.box size={14} />}
            label="Assets"
            hint="Dynamic-field records"
          />
          <QuickLink
            href={`/admin/companies/${company.id}/articles`}
            icon={<Icon.doc size={14} />}
            label="Articles"
            hint="Runbooks, how-tos, KB"
          />
          <QuickLink
            href={`/admin/companies/${company.id}/photos`}
            icon={<Icon.image size={14} />}
            label="Photos"
            hint="Every uploaded image"
          />
          <QuickLink
            href={`/admin/companies/${company.id}/domains`}
            icon={<Icon.globe size={14} />}
            label="Domains"
            hint={domainHint(domains)}
          />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 10,
          }}
        >
          <ContactPanel company={company} manage={manage} />
          <AddressPanel company={company} manage={manage} />
          <ClassificationPanel company={company} manage={manage} />
        </div>

        {alertCount(domains) > 0 && (
          <DomainAlertBanner domains={domains} companyId={company.id} />
        )}

        <Panel
          title="Recent assets"
          actions={
            <Link
              href={`/admin/companies/${company.id}/assets`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11.5,
                color: 'var(--accent)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              browse all
              <Icon.chevron size={10} />
            </Link>
          }
          noPad
        >
          {recentAssets.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 12.5,
              }}
            >
              No assets yet — create one from the{' '}
              <Link
                href={`/admin/companies/${company.id}/assets/new`}
                style={{ color: 'var(--accent)' }}
              >
                Assets page
              </Link>
              .
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {recentAssets.map((a, i) => (
                <li
                  key={a.id}
                  style={{
                    padding: '10px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    borderBottom:
                      i === recentAssets.length - 1
                        ? 'none'
                        : '1px solid var(--line)',
                  }}
                >
                  <LayoutSwatch icon={a.layoutIcon} color={a.layoutColor} size={22} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link
                      href={`/admin/companies/${company.id}/assets/${a.id}`}
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'inherit',
                      }}
                    >
                      {a.name}
                    </Link>
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10.5,
                        color: 'var(--dim)',
                      }}
                    >
                      {a.layoutName}
                      {a.externalSource ? ` · ${a.externalSource.toLowerCase()}` : ''}
                    </div>
                  </div>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      color: 'var(--dim)',
                    }}
                  >
                    {new Date(a.updatedAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div id="memberships" style={{ scrollMarginTop: 80 }}>
          {membershipsError ? (
            <ErrorBanner
              title="Couldn't load memberships."
              detail={
                (membershipsError.problem as { detail?: string } | undefined)
                  ?.detail ??
                `The memberships endpoint returned HTTP ${membershipsError.status}.`
              }
            />
          ) : null}
          <Panel title="Memberships" noPad>
            <CompanyMemberships
              companyId={company.id}
              companyName={company.name}
              companySlug={company.slug}
              companyArchivedAt={company.archivedAt}
              initial={memberships}
              canManage={manageMemberships}
            />
          </Panel>
        </div>
      </PageBody>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
// Header composition
// ───────────────────────────────────────────────────────────────────

function HeaderMeta({ company }: { company: CompanyDetail }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        marginTop: 4,
      }}
    >
      <Tag tone={companyTypeTone(company.type)} dot>
        {companyTypeLabel(company.type)}
      </Tag>
      {company.archivedAt ? (
        <Tag tone="warn" dot>
          archived
        </Tag>
      ) : (
        <Tag tone="ok" dot>
          active
        </Tag>
      )}
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          color: 'var(--dim)',
        }}
      >
        /{company.slug}
      </span>
      {company.parent && (
        <Link
          href={`/admin/companies/${company.parent.id}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: 'var(--muted)',
            textDecoration: 'none',
          }}
        >
          <Icon.chevron size={10} style={{ transform: 'rotate(180deg)' }} />
          {company.parent.name}
        </Link>
      )}
      {company.childrenCount > 0 && (
        <Tag tone="outline">
          {company.childrenCount} child{company.childrenCount === 1 ? '' : 'ren'}
        </Tag>
      )}
      {company.quickNotes && (
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-2)',
            fontStyle: 'italic',
            maxWidth: 600,
          }}
        >
          {company.quickNotes}
        </span>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Panels
// ───────────────────────────────────────────────────────────────────

function ContactPanel({
  company,
  manage,
}: {
  company: CompanyDetail;
  manage: boolean;
}) {
  const hasAny =
    company.contactName ||
    company.contactEmail ||
    company.contactPhone ||
    company.generalEmail ||
    company.phone ||
    company.fax ||
    company.website;
  return (
    <Panel title="Contact">
      {!hasAny ? (
        <EmptyCTA
          label="No contact info yet."
          href={manage ? `/admin/companies/${company.id}/settings` : undefined}
          hint={manage ? 'Add in Settings' : undefined}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(company.contactName || company.contactTitle) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13.5, color: 'var(--text)', fontWeight: 500 }}>
                {company.contactName ?? '—'}
              </span>
              {company.contactTitle && (
                <span
                  style={{
                    fontSize: 11.5,
                    color: 'var(--dim)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {company.contactTitle}
                </span>
              )}
            </div>
          )}
          {company.contactEmail && (
            <Row label="Contact email" value={emailLink(company.contactEmail)} />
          )}
          {company.contactPhone && (
            <Row label="Contact phone" value={telLink(company.contactPhone)} />
          )}
          {company.generalEmail && (
            <Row label="General email" value={emailLink(company.generalEmail)} />
          )}
          {company.phone && <Row label="Main phone" value={telLink(company.phone)} />}
          {company.fax && <Row label="Fax" value={telLink(company.fax)} />}
          {company.website && (
            <Row label="Website" value={externalLink(company.website)} />
          )}
        </div>
      )}
    </Panel>
  );
}

function AddressPanel({
  company,
  manage,
}: {
  company: CompanyDetail;
  manage: boolean;
}) {
  const lines = formatAddressLines(company);
  const mapUrl = buildMapsUrl(company);
  return (
    <Panel title="Address">
      {lines.length === 0 ? (
        <EmptyCTA
          label="No address yet."
          href={manage ? `/admin/companies/${company.id}/settings` : undefined}
          hint={manage ? 'Add in Settings' : undefined}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <address
            style={{
              fontStyle: 'normal',
              lineHeight: 1.55,
              fontSize: 13,
              color: 'var(--text)',
            }}
          >
            {lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </address>
          {mapUrl && (
            <a
              href={mapUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11.5,
                color: 'var(--accent)',
                fontFamily: 'var(--font-mono)',
                textDecoration: 'none',
                alignSelf: 'flex-start',
              }}
            >
              <Icon.globe size={11} /> Open in Google Maps
              <Icon.chevron size={10} />
            </a>
          )}
        </div>
      )}
    </Panel>
  );
}

function ClassificationPanel({
  company,
  manage,
}: {
  company: CompanyDetail;
  manage: boolean;
}) {
  return (
    <Panel title="Classification">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Row
          label="Type"
          value={
            <Tag tone={companyTypeTone(company.type)} dot>
              {companyTypeLabel(company.type)}
            </Tag>
          }
        />
        <Row
          label="Parent"
          value={
            company.parent ? (
              <Link
                href={`/admin/companies/${company.parent.id}`}
                style={{ color: 'var(--text)', textDecoration: 'none' }}
              >
                {company.parent.name}
              </Link>
            ) : manage ? (
              <Link
                href={`/admin/companies/${company.id}/settings`}
                style={{
                  color: 'var(--dim)',
                  fontSize: 12,
                  textDecoration: 'none',
                }}
              >
                Not set — add in Settings
              </Link>
            ) : (
              <span style={{ color: 'var(--dim)' }}>—</span>
            )
          }
        />
        {company.childrenCount > 0 && (
          <Row
            label="Children"
            value={
              <span>
                {company.childrenCount} company
                {company.childrenCount === 1 ? '' : 'ies'}
              </span>
            }
          />
        )}
        <Row label="Active members" value={<span>{company.memberCount}</span>} />
        <Row
          label="Created"
          value={
            <span
              style={{
                color: 'var(--dim)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
              }}
            >
              {new Date(company.createdAt).toLocaleDateString()}
            </span>
          }
        />
      </div>
    </Panel>
  );
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

function QuickLink({
  href,
  icon,
  label,
  hint,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        color: 'var(--text)',
        textDecoration: 'none',
      }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 5,
          background: 'var(--panel-2)',
          border: '1px solid var(--line-2)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--accent)',
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {hint}
        </div>
      </div>
      <Icon.chevron size={11} style={{ color: 'var(--dim)' }} />
    </Link>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--muted)',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 13, color: 'var(--text)' }}>{value}</span>
    </div>
  );
}

function EmptyCTA({
  label,
  hint,
  href,
}: {
  label: string;
  hint?: string;
  href?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        color: 'var(--dim)',
        fontSize: 12.5,
      }}
    >
      <span>{label}</span>
      {hint && href && (
        <Link
          href={href}
          style={{
            fontSize: 11.5,
            color: 'var(--accent)',
            fontFamily: 'var(--font-mono)',
            textDecoration: 'none',
            alignSelf: 'flex-start',
          }}
        >
          {hint} →
        </Link>
      )}
    </div>
  );
}

function emailLink(email: string) {
  return (
    <a
      href={`mailto:${email}`}
      style={{ color: 'var(--accent)', textDecoration: 'none' }}
    >
      {email}
    </a>
  );
}

function telLink(phone: string) {
  return (
    <a
      href={`tel:${phone.replace(/[^+\d]/g, '')}`}
      style={{ color: 'var(--text)', textDecoration: 'none' }}
    >
      {phone}
    </a>
  );
}

function externalLink(url: string) {
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: 'var(--accent)',
        textDecoration: 'none',
        wordBreak: 'break-all',
      }}
    >
      {url.replace(/^https?:\/\//i, '')}
    </a>
  );
}

function domainHint(domains: MonitoredDomain[]): string {
  if (domains.length === 0) return 'No domains yet';
  const bad = alertCount(domains);
  if (bad === 0) return `${domains.length} healthy`;
  return `${bad} need attention`;
}

function alertCount(domains: MonitoredDomain[]): number {
  return domains.filter(
    (d) =>
      d.latestStatus === 'EXPIRING' ||
      d.latestStatus === 'EXPIRED' ||
      d.latestStatus === 'FAIL',
  ).length;
}

/**
 * Compact, single-row banner. Only rendered when the company has at
 * least one domain in a non-OK state — the full details live on the
 * dedicated `/domains` tab now.
 */
function DomainAlertBanner({
  domains,
  companyId,
}: {
  domains: MonitoredDomain[];
  companyId: string;
}) {
  const counts = domains.reduce(
    (acc, d) => {
      acc[d.latestStatus] = (acc[d.latestStatus] ?? 0) + 1;
      return acc;
    },
    {} as Record<MonitoredDomain['latestStatus'], number>,
  );
  const total = alertCount(domains);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        background: 'var(--danger-soft)',
        border: '1px solid color-mix(in oklch, var(--danger) 30%, transparent)',
        borderRadius: 6,
      }}
    >
      <Icon.warn size={14} style={{ color: 'var(--danger)' }} />
      <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>
        <strong>{total}</strong> domain{total === 1 ? '' : 's'} need attention
        {' '}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--muted)',
            fontSize: 11.5,
          }}
        >
          · {(counts.EXPIRING ?? 0)} expiring · {(counts.EXPIRED ?? 0)} expired ·{' '}
          {(counts.FAIL ?? 0)} failed
        </span>
      </span>
      <Link
        href={`/admin/companies/${companyId}/domains`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 11.5,
          color: 'var(--accent)',
          fontFamily: 'var(--font-mono)',
          textDecoration: 'none',
        }}
      >
        manage
        <Icon.chevron size={10} />
      </Link>
    </div>
  );
}
