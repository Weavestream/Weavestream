import { useEffect, useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import { Icon } from '../../components/Icon';
import { ListRow, SectionLabel } from '../../components/primitives';
import {
  EmptyState,
  ErrorBanner,
  OfflineBanner,
  SkeletonList,
} from '../../components/states';
import { useOnline } from '../../lib/use-online';
import { useOrgScope } from '../../lib/org-scope';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useBackOr } from '../../lib/use-back';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useMe } from '../../screens/TabShell';
import { useAsk } from '../../components/ask/AskProvider';
import { groupHits } from './grouping';
import { routeForHit } from './hit-route';
import { SEARCH_DEBOUNCE_MS, useSearchResults } from './queries';
import { Snippet } from './Snippet';

/**
 * The global search screen — 2b's full-screen takeover. The tab bar is
 * hidden (`hideTabBarFor`), the field row replaces the header, and the
 * grouped results replace the content.
 *
 * Current org ONLY: `companyId` is always sent and there is no scope
 * toggle — that cut removes a real onsite failure mode (copying a
 * credential out of the wrong client's record). See queries.ts.
 *
 * The field auto-focuses on open — the sanctioned exception to the
 * no-autofocus rule (Sheet.tsx): tapping the search icon IS the intent
 * to type, and there is no content underneath for the keyboard to bury.
 * iOS may occasionally decline to raise the keyboard for programmatic
 * focus; that is accepted (Phase 4 real-device checklist).
 */
export function SearchScreen({ query }: { query: string }) {
  const { currentOrg, scopeStatus, retry } = useOrgScope();
  const me = useMe();
  const online = useOnline();
  const navigate = useScopedNavigate();
  const done = useBackOr('/passwords');
  const location = useLocation();

  // Seeded once from the route: the screen unmounts on navigation away,
  // so a later back-to-search remounts with the restored `?q=`.
  const [input, setInput] = useState(query);
  const debounced = useDebouncedValue(input.trim(), SEARCH_DEBOUNCE_MS);

  // Overlay param riding this screen's URL (`?sheet=ask` from the Ask
  // handoff card). The mirror effect below must carry it, or a debounce
  // firing just after the card was tapped would strip it and slam the
  // overlay shut.
  const rawSheet = (location.search as Record<string, unknown>).sheet;
  const sheet = rawSheet === 'org' || rawSheet === 'ask' ? rawSheet : undefined;

  // Mirror the settled query into the URL (`replace`, so typing never
  // grows history) — back-from-detail then restores this exact search.
  useEffect(() => {
    if (debounced === query) return;
    navigate({
      to: '/search',
      replace: true,
      search: {
        ...(sheet ? { sheet } : {}),
        ...(debounced ? { q: debounced } : {}),
      },
    });
  }, [debounced, query, sheet, navigate]);

  const orgId = currentOrg?.id ?? null;
  const results = useSearchResults(orgId, debounced);
  const askVisible = me?.role !== 'CLIENT_USER';
  const { setDraft } = useAsk();

  const openAsk = () => {
    // Prefill the composer with the query — the card's whole promise.
    setDraft(debounced);
    // Push, mirroring the Shell's `showSheet`: back closes the overlay.
    navigate({
      to: '/search',
      search: { ...(debounced ? { q: debounced } : {}), sheet: 'ask' },
    });
  };

  const groups = results.data ? groupHits(results.data.items) : [];

  return (
    <>
      <div className="mx-auto flex w-full max-w-page shrink-0 items-center gap-2.5 px-4 pb-3 pt-edge-t">
        <form
          role="search"
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            // `enterKeyHint="search"` — Search on the keyboard just
            // dismisses it; results are already live via the debounce.
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <div className="flex h-12 items-center gap-2 rounded-[14px] border-2 border-accent bg-surface pl-3.5 pr-1">
            <Icon name="search" size={21} className="shrink-0 text-accent" />
            <input
              type="search"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search"
              aria-label="Search"
              // The sanctioned autofocus exception — see the docblock.
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              maxLength={200}
              className={
                'min-w-0 flex-1 bg-transparent font-mono text-[17px] ' +
                'text-text outline-none placeholder:text-dim'
              }
            />
            {input && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setInput('')}
                className="flex shrink-0 items-center justify-center px-1.5 text-faint active:text-text"
              >
                <Icon name="cancel" size={20} />
              </button>
            )}
          </div>
        </form>
        <button
          type="button"
          onClick={done}
          className="shrink-0 rounded-btn px-2 text-body font-medium text-accent-text active:bg-panel-2"
        >
          Done
        </button>
      </div>

      <main className="mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col gap-4 overflow-y-auto px-4 pb-edge-b">
        {!online && <OfflineBanner />}

        {scopeStatus === 'resolving' && <SkeletonList rows={5} variant="row" />}

        {scopeStatus === 'error' && (
          <ErrorBanner
            title="Couldn’t load your organizations."
            detail="Check your connection and try again."
            onRetry={retry}
          />
        )}

        {scopeStatus === 'ready' && !currentOrg && (
          <EmptyState message="No organizations available. Ask an administrator to give you access to a client." />
        )}

        {scopeStatus === 'ready' && currentOrg && (
          <>
            {!debounced && (
              <EmptyState
                message={`Searches passwords, assets, and articles in ${currentOrg.name}.`}
              />
            )}

            {debounced !== '' && results.isPending && (
              <SkeletonList rows={5} variant="row" />
            )}

            {debounced !== '' && results.isError && (
              <ErrorBanner
                title="Search is unavailable right now."
                detail="Check your connection and try again."
                onRetry={() => void results.refetch()}
              />
            )}

            {debounced !== '' && results.data && groups.length === 0 && (
              <>
                <EmptyState message={`No matches in ${currentOrg.name}.`} />
                {askVisible && (
                  <AskHandoffCard query={debounced} onOpen={openAsk} />
                )}
              </>
            )}

            {groups.length > 0 && (
              <>
                {groups.map((group) => (
                  <section key={group.kind} className="flex flex-col gap-2">
                    <div className="flex items-center gap-1.75">
                      <Icon
                        name={group.icon}
                        size={18}
                        className="text-muted"
                      />
                      <SectionLabel>{group.label}</SectionLabel>
                    </div>
                    {group.hits.map((hit) => {
                      const to = routeForHit(hit.kind, hit.id);
                      return (
                        <ListRow
                          key={`${hit.kind}:${hit.id}`}
                          title={hit.title}
                          metaFont="sans"
                          meta={
                            hit.snippet ? (
                              <Snippet snippet={hit.snippet} />
                            ) : (
                              (hit.layoutName ?? undefined)
                            )
                          }
                          minHeight="row"
                          trailing={
                            to ? (
                              <Icon
                                name="chevron_right"
                                size={22}
                                className="shrink-0 text-faint"
                              />
                            ) : undefined
                          }
                          onClick={
                            to
                              ? () =>
                                  // `backLabel`: the detail's chevron pops
                                  // back HERE, so it must say "Search",
                                  // not the structural tab name.
                                  navigate({
                                    to,
                                    upIsBack: true,
                                    backLabel: 'Search',
                                  })
                              : undefined
                          }
                        />
                      );
                    })}
                  </section>
                ))}
                {askVisible && (
                  <AskHandoffCard query={debounced} onOpen={openAsk} />
                )}
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}

/**
 * The design's last-row handoff into Ask anything, pre-filled with the
 * query. Hidden for CLIENT_USER (Ask is hidden on client portals on
 * desktop; mobile mirrors that — cosmetic parity, authz is server-side).
 */
function AskHandoffCard({
  query,
  onOpen,
}: {
  query: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={
        'flex w-full items-center gap-3 rounded-group bg-accent-soft ' +
        'p-3.5 text-left transition-colors active:bg-accent-line'
      }
    >
      <Icon name="auto_awesome" size={22} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 text-body font-medium leading-snug text-accent-deep">
        Ask anything about “{query}” instead
      </span>
      <Icon name="chevron_right" size={22} className="shrink-0 text-accent" />
    </button>
  );
}
