import Link from 'next/link';
import { PageBody, PageHeader } from '../../../components/shell/page-header';
import {
  CompanyAvatar,
  Icon,
  LayoutSwatch,
  Panel,
  StarButton,
  Stat,
  Tag,
} from '../../../components/ui';
import type { EntityType } from '../../../components/ui/star-button';
import {
  getMe,
  getSettings,
  listDomainAlerts,
  listRecentActivity,
  listStarred,
  serverApiFetch,
  type CompanyListItem,
  type CompanyPage,
  type DomainAlert,
  type RecentActivityItem,
  type StarredItem,
  type UserPage,
} from '../../../lib/server-api';
import { buildTerm, lower } from '../../../lib/term';
import { companyAccent } from '../../../lib/company-format';
import { DomainAlertsPanel } from './domain-alerts-panel';

export default async function AdminDashboard() {
  const me = (await getMe())!;
  const term = buildTerm(await getSettings());
  // Parallelise every data source — none depends on any of the others
  // and each hit is independently cheap. A single `Promise.all` keeps
  // the dashboard well under the 500 ms first-paint budget.
  const [
    companiesRes,
    usersRes,
    recentCompaniesRes,
    starred,
    alerts,
    recent,
  ] = await Promise.all([
    serverApiFetch<CompanyPage>('/companies?limit=200&includeArchived=true'),
    serverApiFetch<UserPage>('/users?limit=200'),
    // Phase 9b.3: "Recent companies" widget — six most recently
    // updated in the caller's scope, excluding archived.
    serverApiFetch<CompanyPage>('/companies?limit=6&sort=updatedAt&order=desc'),
    listStarred(),
    listDomainAlerts(30),
    listRecentActivity(10),
  ]);
  const companies = companiesRes.data?.items ?? [];
  const users = usersRes.data?.items ?? [];
  const recentCompanies = recentCompaniesRes.data?.items ?? [];
  const activeCompanies = companies.filter((c) => !c.archivedAt).length;
  const activeUsers = users.filter((u) => u.isActive).length;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Dashboard' }]}
        title={`Hello, ${me.name.split(' ')[0] ?? me.name}`}
        description="The operator control plane for Weavestream. Pick an area from the sidebar to get started."
      />
      <PageBody>
        <Panel title="At a glance">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 24,
            }}
          >
            <Stat label={term.other} value={activeCompanies} />
            <Stat label="Users" value={activeUsers} />
            <Stat
              label={`Archived ${lower(term.other)}`}
              value={companies.length - activeCompanies}
            />
            <Stat label="Inactive users" value={users.length - activeUsers} />
            <Stat
              label="Memberships"
              value={companies.reduce((acc, c) => acc + c.memberCount, 0)}
            />
          </div>
        </Panel>

        {/*
          Three "what's happening" widgets share a single responsive
          row. `auto-fit minmax(300px, 1fr)` gives us 3 columns on wide
          screens, 2 on a standard laptop sidebar-pane, and stacks to a
          single column on narrow viewports — no explicit media query
          needed.
        */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: 16,
            alignItems: 'stretch',
          }}
        >
          <StarredPanel starred={starred} termOne={term.one} />
          <RecentCompaniesPanel
            rows={recentCompanies}
            termOne={term.one}
            termOther={term.other}
          />
          <RecentActivityPanel items={recent} termOther={term.other} />
        </div>

        <DomainAlertsPanel alerts={alerts} />
        <Panel title="You">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
            <Row label="Email" value={<code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{me.email}</code>} />
            <Row label="Role" value={<Tag tone="accent" dot>{me.role}</Tag>} />
            <Row
              label="Two-factor"
              value={
                me.mfaEnabled ? (
                  <Tag tone="ok" dot>
                    enabled
                  </Tag>
                ) : (
                  <Tag tone="warn" dot>
                    pending
                  </Tag>
                )
              }
            />
            <Row
              label="Memberships"
              value={
                me.memberships.length === 0 ? (
                  <span style={{ color: 'var(--muted)' }}>none</span>
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {me.memberships.map((m) => (
                      <Tag key={m.id} tone="info">
                        {m.company.name}
                      </Tag>
                    ))}
                  </div>
                )
              }
            />
          </div>
        </Panel>
      </PageBody>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
// Starred items (companies, passwords, assets, articles)
// ───────────────────────────────────────────────────────────────────

/**
 * Operator-pinned items across every supported entity type. The list
 * is returned already sorted by `starredAt` desc from the API, so
 * users see the thing they pinned most recently at the top regardless
 * of its type. Each row picks its own glyph, sub-line, and link target
 * based on the discriminated `type`.
 */
function StarredPanel({
  starred,
  termOne,
}: {
  starred: StarredItem[];
  termOne: string;
}) {
  // Starred is uncapped (users curate their own list), so the panel
  // must scroll internally — otherwise a heavy-starrer blows up the
  // equal-height row. `style` makes the outer section a flex column;
  // `bodyStyle` lets the body grow to fill the grid-row height; the
  // inner `<div>` below then becomes the scroll container.
  return (
    <Panel
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Starred
          {starred.length > 0 && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--dim)',
                fontWeight: 400,
              }}
            >
              {starred.length}
            </span>
          )}
        </span>
      }
      style={{ display: 'flex', flexDirection: 'column' }}
      bodyStyle={{ flex: 1, minHeight: 0, display: 'flex' }}
    >
      {starred.length === 0 ? (
        <div
          style={{
            padding: 6,
            color: 'var(--muted)',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          Star a {lower(termOne)}, password, asset, or article from its page to
          pin it here for faster access.
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
            alignContent: 'start',
          }}
        >
          {starred.map((item) => (
            <StarredCard key={`${item.type}:${item.id}`} item={item} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function StarredCard({ item }: { item: StarredItem }) {
  const href = starredHref(item);
  const isArchived =
    item.archivedAt !== null ||
    (item.type !== 'company' && item.companyArchivedAt !== null);
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 6,
      }}
    >
      <Link
        href={href}
        style={{
          display: 'flex',
          flex: 1,
          alignItems: 'center',
          gap: 10,
          minWidth: 0,
          color: 'var(--text)',
          textDecoration: 'none',
        }}
      >
        <StarredGlyph item={item} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.name}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {starredSubline(item)}
            {isArchived ? ' · archived' : ''}
          </div>
        </div>
      </Link>
      <StarButton
        entityType={item.type as EntityType}
        entityId={item.id}
        initialStarred={true}
        iconSize={14}
      />
    </div>
  );
}

/**
 * Type-appropriate glyph for each item. Companies use their avatar
 * (with logo if uploaded); other entities get a tinted icon chip
 * that matches the rest of the app's visual vocabulary (layout
 * swatch for assets, info-tone chips for passwords & articles).
 */
function StarredGlyph({ item }: { item: StarredItem }) {
  switch (item.type) {
    case 'company': {
      const accent = companyAccent(item.id);
      return (
        <CompanyAvatar
          name={item.name}
          color={accent}
          size={28}
          logoUrl={item.logo?.thumbnailUrl ?? item.logo?.url ?? null}
        />
      );
    }
    case 'asset':
      return (
        <LayoutSwatch
          icon={item.layoutIcon ?? 'box'}
          color="var(--info)"
          size={28}
        />
      );
    case 'password':
      return <TypeChip icon={<Icon.key size={14} />} color="var(--warn)" />;
    case 'article':
      return <TypeChip icon={<Icon.doc size={14} />} color="var(--accent)" />;
  }
}

function TypeChip({
  icon,
  color,
}: {
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 5,
        display: 'grid',
        placeItems: 'center',
        background: `color-mix(in oklch, ${color} 14%, transparent)`,
        color,
        border: `1px solid color-mix(in oklch, ${color} 30%, transparent)`,
        flexShrink: 0,
      }}
    >
      {icon}
    </div>
  );
}

function starredHref(item: StarredItem): string {
  switch (item.type) {
    case 'company':
      return `/admin/companies/${item.id}`;
    case 'password':
      return `/admin/companies/${item.companyId}/passwords/${item.id}`;
    case 'asset':
      return `/admin/companies/${item.companyId}/assets/${item.id}`;
    case 'article':
      return `/admin/companies/${item.companyId}/articles/${item.id}`;
  }
}

function starredSubline(item: StarredItem): string {
  switch (item.type) {
    case 'company':
      return `${item.memberCount} member${item.memberCount === 1 ? '' : 's'}`;
    case 'asset':
      return item.layoutName
        ? `${item.layoutName} · ${item.companyName}`
        : item.companyName;
    case 'password':
      return `Password · ${item.companyName}`;
    case 'article':
      return `Article · ${item.companyName}`;
  }
}

// ───────────────────────────────────────────────────────────────────
// Recent companies
// ───────────────────────────────────────────────────────────────────

function RecentCompaniesPanel({
  rows,
  termOne,
  termOther,
}: {
  rows: CompanyListItem[];
  termOne: string;
  termOther: string;
}) {
  return (
    <Panel
      title={`Recent ${lower(termOther)}`}
      actions={
        <Link
          href="/admin/companies"
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
          browse all
          <Icon.chevron size={10} />
        </Link>
      }
    >
      {rows.length === 0 ? (
        <div
          style={{
            padding: 8,
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          No {lower(termOther)} yet.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
          }}
        >
          {rows.map((c) => (
            <RecentCompanyCard key={c.id} company={c} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function RecentCompanyCard({ company }: { company: CompanyListItem }) {
  const accent = companyAccent(company.id);
  return (
    <Link
      href={`/admin/companies/${company.id}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        color: 'var(--text)',
        textDecoration: 'none',
      }}
    >
      <CompanyAvatar
        name={company.name}
        color={accent}
        size={28}
        logoUrl={company.logo?.thumbnailUrl ?? company.logo?.url ?? null}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {company.name}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--dim)',
          }}
        >
          {relative(company.updatedAt)}
          {company.memberCount > 0
            ? ` · ${company.memberCount} member${
                company.memberCount === 1 ? '' : 's'
              }`
            : ''}
        </div>
      </div>
    </Link>
  );
}

// ───────────────────────────────────────────────────────────────────
// Recent activity
// ───────────────────────────────────────────────────────────────────

/**
 * Cross-company activity feed — the 10 most recently updated assets
 * and articles in the caller's scope. Deliberately simple: a merged
 * list, timestamp + author, link into the thing itself. No filtering
 * or pagination here; operators who want more detail use the Audit
 * page.
 */
function RecentActivityPanel({
  items,
  termOther,
}: {
  items: RecentActivityItem[];
  termOther: string;
}) {
  return (
    <Panel title="Recent activity" noPad>
      {items.length === 0 ? (
        <div
          style={{
            padding: 20,
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          Nothing's been updated across your {lower(termOther)} yet.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((it, i) => (
            <li
              key={`${it.type}:${it.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderBottom:
                  i === items.length - 1 ? 'none' : '1px solid var(--line)',
              }}
            >
              <span
                aria-hidden
                style={{
                  color: 'var(--accent)',
                  display: 'inline-flex',
                  width: 22,
                  height: 22,
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--line-2)',
                  borderRadius: 5,
                }}
              >
                {it.type === 'asset' ? (
                  <Icon.box size={12} />
                ) : (
                  <Icon.doc size={12} />
                )}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Link
                  href={activityHref(it)}
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--text)',
                    textDecoration: 'none',
                  }}
                >
                  {it.name}
                </Link>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    color: 'var(--dim)',
                  }}
                >
                  <Link
                    href={`/admin/companies/${it.companyId}`}
                    style={{ color: 'var(--muted)', textDecoration: 'none' }}
                  >
                    {it.companyName}
                  </Link>
                  {it.updatedByName ? ` · by ${it.updatedByName}` : ''}
                </div>
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10.5,
                  color: 'var(--dim)',
                  flexShrink: 0,
                }}
              >
                {relative(it.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function activityHref(it: RecentActivityItem): string {
  return it.type === 'asset'
    ? `/admin/companies/${it.companyId}/assets/${it.id}`
    : `/admin/companies/${it.companyId}/articles/${it.id}`;
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          width: 120,
          flexShrink: 0,
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{value}</div>
    </div>
  );
}
