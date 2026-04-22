import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { CompanyShell } from '../../../components/shell/company-shell';
import {
  getAssetCountsByLayout,
  getMe,
  getSettings,
  listDomains,
  listLayouts,
  listPasswords,
} from '../../../lib/server-api';
import { buildTerm } from '../../../lib/term';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}): Promise<Metadata> {
  const { companySlug } = await params;
  const me = await getMe();
  const membership = me?.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) return {};
  const name = membership.company.name;
  return {
    title: {
      default: name,
      template: `%s · ${name}`,
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

  const membership = me.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) {
    // SUPER_ADMINs and operators don't need a membership to read
    // company data, but the portal shell is membership-scoped by
    // design. Send them to the admin view instead.
    if (me.role === 'SUPER_ADMIN') {
      redirect('/admin/companies');
    }
    notFound();
  }

  if (membership.expiresAt && new Date(membership.expiresAt) <= new Date()) {
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
            Your access to <strong>{membership.company.name}</strong> ended on{' '}
            {new Date(membership.expiresAt).toLocaleDateString()}. Contact an
            administrator if you still need access.
          </p>
        </div>
      </div>
    );
  }

  const [settings, layouts, counts, domainList, passwordList] =
    await Promise.all([
      getSettings(),
      listLayouts(),
      getAssetCountsByLayout(membership.company.id),
      // The API already filters out non-`visibleToClients` rows for
      // client users, so every item returned here is portal-eligible.
      // We only need to know "are there any?" to decide whether to
      // show the sidebar entry.
      listDomains(membership.company.id, { limit: 1 }),
      // Same logic for passwords — portal users only see client-
      // visible rows, so the count directly reflects what the sidebar
      // entry would land on.
      listPasswords(membership.company.id),
    ]);
  const term = buildTerm(settings);
  const passwordCount = passwordList.filter((p) => !p.archivedAt).length;

  return (
    <CompanyShell
      me={me}
      company={membership.company}
      layouts={layouts}
      counts={counts}
      term={term}
      mode="portal"
      portalHasDomains={domainList.items.length > 0}
      portalHasPasswords={passwordCount > 0}
      passwordCount={passwordCount}
    >
      {children}
    </CompanyShell>
  );
}
