import { notFound } from 'next/navigation';
import { getMe } from '../../../lib/server-api';
import { PageBody, PageHeader } from '../../../components/shell/page-header';
import { Panel } from '../../../components/ui';

/**
 * Portal home.
 *
 * Deliberately minimal: the sidebar is the navigation surface for the
 * read-only content a client has access to (articles, layouts,
 * domains), and there is no analytics, activity, or operator surface
 * for a client to act on here. The dashboard is reserved as a canvas
 * for an upcoming MSP-customizable block (pinned links, contact info,
 * quick notes) — kept intentionally empty so we don't promise content
 * we'll want to replace.
 */
export default async function PortalHome({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  const me = (await getMe())!;
  const membership = me.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) notFound();

  const companyName = membership.company.name;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Portal', href: '/' }, { label: companyName }]}
        title={`Welcome to ${companyName}`}
        description="Your IT documentation is available in the sidebar."
      />
      <PageBody>
        <Panel>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 14,
              padding: '40px 24px',
              textAlign: 'center',
            }}
          >
            <p
              style={{
                margin: 0,
                maxWidth: 520,
                fontSize: 14,
                lineHeight: 1.6,
                color: 'var(--text)',
              }}
            >
              This is your <strong>{companyName}</strong> portal — a read-only
              view of the documentation your IT team maintains for you.
              Browse the sidebar to find articles, assets, and monitored
              domains.
            </p>
            <p
              style={{
                margin: 0,
                maxWidth: 520,
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: 'var(--dim)',
                lineHeight: 1.6,
              }}
            >
              Your IT team will be able to pin custom links, notes, and
              contact info here in a future update.
            </p>
          </div>
        </Panel>
      </PageBody>
    </>
  );
}
