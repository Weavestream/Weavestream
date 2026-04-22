import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { CompanyShell } from '../../../../components/shell/company-shell';
import {
  getAssetCountsByLayout,
  getMe,
  getSettings,
  listDomains,
  listLayouts,
  listPasswords,
  serverApiFetch,
  type CompanyDetail,
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
  const res = await serverApiFetch<CompanyDetail>(`/companies/${id}`);
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

  const [me, settings, companyRes, layouts, counts, domainList, passwordList] =
    await Promise.all([
      getMe(),
      getSettings(),
      serverApiFetch<CompanyDetail>(`/companies/${id}`),
      listLayouts(),
      getAssetCountsByLayout(id),
      // Just the first page — we only need a count of rows that
      // warrant attention, not the full list. `limit: 200` is plenty
      // for the alerting badge (any customer with more than 200
      // expiring domains has bigger problems than a sidebar count).
      listDomains(id, { limit: 200 }),
      // Active passwords for the sidebar count + stale badge.
      listPasswords(id),
    ]);
  if (!me) notFound();
  if (!companyRes.ok || !companyRes.data) notFound();
  const company = companyRes.data;
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
    >
      {children}
    </CompanyShell>
  );
}
