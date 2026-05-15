import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { CompanyShell } from '../../../../components/shell/company-shell';
import {
  getActiveLayouts,
  getCompanyActivePasswords,
  getCompanyAssetCounts,
  getCompanyDetail,
  getCompanyDomainsBasic,
  getCompanySubnetsBasic,
  getMe,
  getSettings,
  throwUnlessFound,
} from '../../../../lib/server-api';
import { buildTerm } from '../../../../lib/term';

/**
 * Shell + title-template for every page under `/admin/companies/[id]`.
 *
 * Sibling pages under `/admin/(global)/**` install the `AdminShell` via
 * their own route-group layout. Those two subtrees never overlap, so
 * there's no double-wrapping to worry about.
 *
 * Data fetched once here — `me`, `settings`, the full `layouts`
 * catalog, and the per-layout asset counts — hydrates both the
 * sidebar and any nested page that calls the same helpers (React's
 * `cache()` dedupes per request).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const res = await getCompanyDetail(id);
  const name = res.data?.name;
  if (!name) return {};
  // "%s" is filled in by child `generateMetadata` calls. Leaf pages
  // without their own title fall back to the company name alone.
  return {
    title: {
      default: name,
      template: `%s · ${name}`,
    },
  };
}

export default async function CompanyScopedLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [
    me,
    settings,
    companyRes,
    layouts,
    counts,
    domainList,
    passwordList,
    subnetList,
  ] = await Promise.all([
    getMe(),
    getSettings(),
    getCompanyDetail(id),
    getActiveLayouts(),
    getCompanyAssetCounts(id),
    getCompanyDomainsBasic(id),
    getCompanyActivePasswords(id),
    getCompanySubnetsBasic(id),
  ]);
  if (!me) notFound();
  // `throwUnlessFound` maps 404s to `notFound()`, 429s to a dedicated
  // `RateLimitedError` boundary, and network outages to
  // `ApiUnavailableError` — replacing the old `if (!ok || !data) notFound()`
  // catch-all that was surfacing 429s from the Docker throttler as a
  // misleading 404 page.
  const company = throwUnlessFound(companyRes, `/companies/${id}`);
  const term = buildTerm(settings);

  const domainCount = domainList.items.length;
  const domainBadge = domainList.items.filter((d) =>
    d.latestStatus === 'EXPIRING' ||
    d.latestStatus === 'EXPIRED' ||
    d.latestStatus === 'FAIL'
  ).length;

  const now = Date.now();
  const passwordCount = passwordList.length;
  const passwordStaleBadge = passwordList.filter((p) => {
    if (p.archivedAt) return false;
    if (p.expiresAt && Date.parse(p.expiresAt) <= now) return true;
    if (p.lastRotatedAt && p.rotationReminderDays) {
      const due =
        Date.parse(p.lastRotatedAt) + p.rotationReminderDays * 86_400_000;
      if (due <= now) return true;
    }
    if ((p.pwnedCount ?? 0) > 0) return true;
    return false;
  }).length;

  const subnetCount = subnetList.length;
  const subnetConflictBadge = subnetList.reduce(
    (sum, s) => sum + (s.conflictCount ?? 0),
    0,
  );

  // Sticky note is admin-only by design; the pair (text + severity) is
  // reconciled at the API layer so we just trust whatever came back.
  const stickyNote =
    company.stickyNoteText && company.stickyNoteSeverity
      ? {
          text: company.stickyNoteText,
          severity: company.stickyNoteSeverity,
        }
      : null;

  return (
    <CompanyShell
      me={me}
      company={company}
      layouts={layouts}
      counts={counts}
      term={term}
      domainCount={domainCount}
      domainBadge={domainBadge}
      passwordCount={passwordCount}
      passwordStaleBadge={passwordStaleBadge}
      subnetCount={subnetCount}
      subnetConflictBadge={subnetConflictBadge}
      stickyNote={stickyNote}
    >
      {children}
    </CompanyShell>
  );
}
