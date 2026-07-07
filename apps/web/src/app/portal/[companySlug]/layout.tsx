import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { CompanyShell } from '../../../components/shell/company-shell';
import {
  getAssetCountsByLayout,
  getMe,
  getMeForMetadata,
  getSettings,
  listDomains,
  listLayouts,
  listPasswords,
  listSubnets,
} from '../../../lib/server-api';
import { resolvePortalCompany } from '../../../lib/portal-company';
import { buildTerm } from '../../../lib/term';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}): Promise<Metadata> {
  const { companySlug } = await params;
  const me = await getMeForMetadata();
  if (!me) return {};
  let company: { id: string; name: string; slug: string };
  try {
    company = await resolvePortalCompany(me, companySlug);
  } catch {
    return {};
  }
  return {
    title: {
      default: company.name,
      template: `%s · ${company.name}`,
    },
  };
}

/**
 * Portal shell. Uses the shared `CompanyShell` in `portal` mode so
 * the client-side sidebar matches the operator-side sidebar
 * structure exactly — same layouts, same counts, same affordances
 * — but with portal-native hrefs and a header that collapses to a
 * static chip when the user has a single membership (there's
 * nowhere meaningful to go by clicking the logo or title in that
 * case).
 */
export default async function PortalLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  const cookieStore = await cookies();
  if (!cookieStore.get('ws_session')) redirect('/login');

  const me = await getMe();
  if (!me) redirect('/login');

  // `resolvePortalCompany` returns the company for either a real
  // membership or an admin preview (gated by `canAccessAdminShell` +
  // server-side `/companies` permission filter). Callers that aren't
  // entitled fall through to `notFound()` inside the helper.
  const company = await resolvePortalCompany(me, companySlug);
  const membership = me.memberships.find((m) => m.company.id === company.id);
  const expiresAt = membership?.expiresAt ?? null;

  if (expiresAt && new Date(expiresAt) <= new Date()) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: 'var(--bg)',
          color: 'var(--text)',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <h1
            style={{
              margin: 0,
              fontFamily: 'var(--font-display)',
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: -0.4,
            }}
          >
            Access expired
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8 }}>
            Your access to <strong>{company.name}</strong> ended on{' '}
            {new Date(expiresAt).toLocaleDateString()}. Contact an
            administrator if you still need access.
          </p>
        </div>
      </div>
    );
  }

  const [settings, layouts, counts, domainList, passwordList, subnetList] =
    await Promise.all([
      getSettings(),
      listLayouts(),
      getAssetCountsByLayout(company.id),
      listDomains(company.id, { limit: 1 }),
      listPasswords(company.id),
      listSubnets(company.id),
    ]);
  const term = buildTerm(settings);
  const passwordCount = passwordList.filter((p) => !p.archivedAt).length;

  return (
    <CompanyShell
      me={me}
      company={company}
      layouts={layouts}
      counts={counts}
      term={term}
      mode="portal"
      portalHasDomains={domainList.items.length > 0}
      portalHasPasswords={passwordCount > 0}
      passwordCount={passwordCount}
      subnetCount={subnetList.length}
      portalHasSubnets={subnetList.length > 0}
    >
      {children}
    </CompanyShell>
  );
}
