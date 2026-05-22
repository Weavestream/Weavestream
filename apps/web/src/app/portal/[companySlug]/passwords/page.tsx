import type { Metadata } from 'next';
import Link from 'next/link';
import {
  getMe,
  listPasswords,
  type PasswordSummary,
} from '../../../../lib/server-api';
import { resolvePortalCompany } from '../../../../lib/portal-company';
import {
  PageBody,
  PageHeader,
} from '../../../../components/shell/page-header';
import { Icon, LayoutSwatch, Panel, Tag } from '../../../../components/ui';

export const metadata: Metadata = { title: 'Passwords' };

/**
 * Portal passwords list — membership-scoped, read-only.
 *
 * The API already filters out rows with `visibleToClients=false` for
 * `CLIENT_USER` callers, so every row we receive here is portal-safe.
 * Clicking an entry navigates to the detail page where the reveal
 * flow lives (same auditing, same throttle, same 30s auto-hide as
 * the admin view).
 */
export default async function PortalPasswordsPage({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  const me = (await getMe())!;
  const company = await resolvePortalCompany(me, companySlug);

  const rows = await listPasswords(company.id);
  const active = rows.filter((r) => !r.archivedAt);

  return (
    <>
      <PageHeader
        crumbs={[
          { label: company.name, href: `/portal/${companySlug}` },
          { label: 'Passwords' },
        ]}
        leading={<LayoutSwatch icon="lock" color="var(--accent)" size={48} />}
        title="Passwords"
        description="Credentials shared with your account. Clicking a row lets you reveal the password; every reveal is audit-logged."
      />
      <PageBody>
        <Panel
          title={
            <span>
              {active.length} credential{active.length === 1 ? '' : 's'}
            </span>
          }
          noPad
        >
          {active.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              No credentials have been shared with you yet.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {active.map((p) => (
                <PortalRow
                  key={p.id}
                  row={p}
                  href={`/portal/${companySlug}/passwords/${p.id}`}
                />
              ))}
            </ul>
          )}
        </Panel>
      </PageBody>
    </>
  );
}

function PortalRow({ row, href }: { row: PasswordSummary; href: string }) {
  return (
    <li>
      <Link
        href={href}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          borderTop: '1px solid var(--line)',
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        <Icon.lock size={14} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{row.name}</div>
          {row.username && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {row.username}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {row.hasTotp && <Tag tone="info">TOTP</Tag>}
          {row.requireReasonToView && <Tag tone="warn">reason req.</Tag>}
        </div>
      </Link>
    </li>
  );
}
