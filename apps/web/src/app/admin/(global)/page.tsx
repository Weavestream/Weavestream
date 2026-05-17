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
  getAdminStats,
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
  const [stats, recentCompaniesRes, starred, alerts, recent] =
    await Promise.all([
      getAdminStats(),
      // Phase 9b.3: "Recent companies" widget — ten most recently
      // updated in the caller's scope, excluding archived.
      serverApiFetch<CompanyPage>(
        '/companies?limit=10&sort=updatedAt&order=desc',
      ),
      listStarred(),
      listDomainAlerts(30),
      listRecentActivity(10),
    ]);
  const recentCompanies = recentCompaniesRes.data?.items ?? [];

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Dashboard' }]}
        title={`Hello, ${me.name.split(' ')[0] ?? me.name}`}
        description="Welcome back to Weavestream. Select a tool from the sidebar to manage your workspace."
      />
      <PageBody>
        {stats && (
          <Panel title="At a glance">
            <div
              style={{
                display: 'grid',
                // 2 columns on mobile (even count → no orphan tile in the
                // last row), auto-fit to more columns on wider viewports.
                gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                gap: 16,
              }}
            >
              <Stat label={term.other} value={stats.companies} />
              <Stat label="Users" value={stats.users} />
              <Stat label="Assets" value={stats.assets} />
              <Stat label="Passwords" value={stats.passwords} />
              <Stat label="Articles" value={stats.articles} />
              <Stat label="Domains" value={stats.domains} />
            </div>
          </Panel>
        )}

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
  // Starred is uncapped (users curate their own list). To keep the
  // equal-height widget row stable, the scroll container is taken out
  // of flow with `position: absolute` so its contents don't grow the
  // panel — the section is sized purely by the other widgets via
  // `alignItems: stretch`, and anything that doesn't fit scrolls
  // inside the absolutely-positioned grid.
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
      bodyStyle={{
        flex: 1,
        minHeight: 0,
        padding: 0,
        position: 'relative',
      }}
    >
      {starred.length === 0 ? (
        <div
          style={{
            padding: 12,
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
            position: 'absolute',
            inset: 0,
            padding: 12,
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
      className="ws-card-clickable"
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
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
      className="ws-card-clickable"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
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
 * page. Rendered as a card grid to match the Starred and Recent
 * companies widgets that sit beside it.
 */
function RecentActivityPanel({
  items,
  termOther,
}: {
  items: RecentActivityItem[];
  termOther: string;
}) {
  return (
    <Panel title="Recent activity">
      {items.length === 0 ? (
        <div
          style={{
            padding: 8,
            color: 'var(--muted)',
            fontSize: 13,
          }}
        >
          Nothing's been updated across your {lower(termOther)} yet.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
          }}
        >
          {items.map((it) => (
            <RecentActivityCard key={`${it.type}:${it.id}`} item={it} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function RecentActivityCard({ item }: { item: RecentActivityItem }) {
  return (
    <Link
      href={activityHref(item)}
      className="ws-card-clickable"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        border: '1px solid var(--line)',
        borderRadius: 6,
        color: 'var(--text)',
        textDecoration: 'none',
        minWidth: 0,
      }}
    >
      <TypeChip
        icon={
          item.type === 'asset' ? (
            <Icon.box size={14} />
          ) : (
            <Icon.doc size={14} />
          )
        }
        color={item.type === 'asset' ? 'var(--info)' : 'var(--accent)'}
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
          <span
            style={{
              color:
                item.action === 'created' ? 'var(--ok)' : 'var(--accent)',
              fontWeight: 500,
            }}
          >
            {item.action}
          </span>
          {' · '}
          {item.companyName} · {relative(item.updatedAt)}
        </div>
      </div>
    </Link>
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
