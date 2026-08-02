import { useLocation } from '@tanstack/react-router';
import { AppLogo } from '../../components/AppLogo';
import { Icon } from '../../components/Icon';
import { IconButton, SectionLabel } from '../../components/primitives';
import { EmptyState, ErrorBanner, SkeletonList } from '../../components/states';
import { useEnterOrg } from '../../lib/use-enter-org';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useMe } from '../../screens/TabShell';
import { OrgRow } from '../orgs/OrgRow';
import { useOrgDirectory } from '../orgs/use-org-directory';

/**
 * The global launcher at `/m/app` (Phase 5b) — the technician's
 * starting point BEFORE entering a company scope. No tab bar (that
 * chrome is the "inside a client" signal), no org in context.
 *
 * Order is the build plan's: cross-org search first, pinned
 * organizations second, then the path into all accessible
 * organizations. Selecting an org **pushes** the org's root, so the
 * launcher stays in history and system Back returns here.
 *
 * The header links to **More** — which renders org-free from here
 * (null-stamped push), so account chores (sign-out, appearance,
 * install) are reachable before any company is selected, including
 * with zero companies at all.
 *
 * The org list is the OrgSheet's directory (`useOrgDirectory`), pinned
 * = starred companies — with no current org by construction. The
 * sheet's filter field is deliberately absent here: the launcher's
 * search entry is cross-org RECORD search; finding an org is what the
 * alphabetical list + Show more already do.
 */
export function LauncherScreen() {
  const navigate = useScopedNavigate();
  const enterOrg = useEnterOrg();
  const location = useLocation();
  const me = useMe();

  const { pinned, rest, loading, nothingAtAll, companies, stars } =
    useOrgDirectory({ filter: '', enabled: true });

  // Ask floats bottom-right on the launcher (org-free contract verified
  // in W0/W5): the overlay is presented by the Shell via `?sheet=ask`,
  // same as the center tab in-org. Hidden for CLIENT_USER — desktop
  // portal parity, cosmetic only (authorization stays server-side).
  const askVisible = me?.role !== 'CLIENT_USER';
  const searchSansSheet = Object.fromEntries(
    Object.entries((location.search ?? {}) as Record<string, unknown>).filter(
      ([key]) => key !== 'sheet',
    ),
  );

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col gap-3.25 overflow-y-auto px-4.5 pb-5 pt-edge-t">
      <header className="flex h-11 shrink-0 items-center justify-between">
        <AppLogo height={24} />
        {/* Org-free More: account chores (sign-out, appearance, install)
            without selecting a company. Push, so Back returns here. */}
        <IconButton
          icon="more_horiz"
          label="More"
          onClick={() => navigate({ to: '/more' })}
        />
      </header>

      {/* Cross-org search first. A button styled as the search field it
          opens; the push carries `upIsBack` so search's Done pops back
          here, and the org stamp is null for free (no org in context). */}
      <button
        type="button"
        onClick={() => navigate({ to: '/search', upIsBack: true })}
        className="flex h-[50px] shrink-0 items-center gap-2.5 rounded-field border border-line bg-surface px-3.5 text-left active:bg-panel-2"
      >
        <Icon name="search" size={21} className="text-dim" />
        <span className="min-w-0 flex-1 truncate text-body text-dim">
          Search all organizations
        </span>
      </button>

      {companies.isError && (
        <ErrorBanner
          title="Couldn’t load organizations."
          onRetry={() => {
            void companies.refetch();
            if (stars.isError) void stars.refetch();
          }}
        />
      )}
      {stars.isError && !companies.isError && (
        <ErrorBanner
          title="Couldn’t load your pinned organizations."
          detail="The full list below is unaffected."
          onRetry={() => void stars.refetch()}
        />
      )}

      {loading && <SkeletonList rows={6} variant="row" />}

      {nothingAtAll && (
        <EmptyState message="No organizations available. Ask an administrator to give you access to a client." />
      )}


      {pinned.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>Pinned</SectionLabel>
          <div className="flex flex-col gap-2">
            {pinned.map((org) => (
              <OrgRow
                key={org.id}
                org={org}
                current={false}
                onSelect={(o) => enterOrg(o, { to: '/passwords', history: 'push' })}
              />
            ))}
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>All organizations</SectionLabel>
          <div className="flex flex-col gap-2">
            {rest.map((org) => (
              <OrgRow
                key={org.id}
                org={org}
                current={false}
                onSelect={(o) => enterOrg(o, { to: '/passwords', history: 'push' })}
              />
            ))}
          </div>
          {companies.hasNextPage && (
            <button
              type="button"
              onClick={() => void companies.fetchNextPage()}
              disabled={companies.isFetchingNextPage}
              className="h-tap text-body font-semibold text-accent-text disabled:text-dim"
            >
              {companies.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </button>
          )}
        </section>
      )}

      {askVisible && (
        <button
          type="button"
          aria-label="Ask anything"
          onClick={() =>
            navigate({
              to: '/app',
              search: { ...searchSansSheet, sheet: 'ask' },
            })
          }
          className={
            'fixed bottom-edge-b right-4 z-tabbar flex h-ask w-ask items-center ' +
            'justify-center rounded-ask bg-accent-fill text-accent-fill-ink shadow-ask ' +
            'active:brightness-95'
          }
        >
          <Icon name="auto_awesome" size={26} />
        </button>
      )}
    </main>
  );
}
