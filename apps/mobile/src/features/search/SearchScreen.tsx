import { useEffect, useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import { initialsFromName } from '@weavestream/shared';
import type { SearchHit } from '@weavestream/shared';
import { Icon } from '../../components/Icon';
import { ListRow, SectionLabel } from '../../components/primitives';
import {
  EmptyState,
  ErrorBanner,
  OfflineBanner,
  SkeletonList,
} from '../../components/states';
import { useOnline } from '../../lib/use-online';
import { readOrgStamp } from '../../lib/org-free';
import { useOrgScope } from '../../lib/org-scope';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useBackOr } from '../../lib/use-back';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useEnterOrg } from '../../lib/use-enter-org';
import { useMe } from '../../screens/TabShell';
import { useAsk } from '../../components/ask/AskProvider';
import { groupHits } from './grouping';
import { routeForHit } from './hit-route';
import { SEARCH_DEBOUNCE_MS, useSearchResults } from './queries';
import { HighlightMatches, Snippet, titleCoversQuery } from './Snippet';

/**
 * The global search screen — 2b's full-screen takeover. The tab bar is
 * hidden (`hideTabBarFor`), the field row replaces the header, and the
 * grouped results replace the content.
 *
 * Two scopes, decided by the history entry's org stamp (Phase 5b):
 *
 *  - **In an org** (org-stamped entry): `companyId` is always sent and
 *    there is no scope toggle — that cut removes a real onsite failure
 *    mode (copying a credential out of the wrong client's record).
 *  - **Global** (`orgId: null` stamp — a push from the launcher, or a
 *    reload of one; history state survives reloads): `companyId` is
 *    omitted and the server scopes to the actor's accessible orgs. Each
 *    hit names its organization prominently, and opening one CARRIES
 *    that organization into the destination (switch + stamped push), so
 *    a technician cannot mistake one client's record for another's.
 *
 * The stamp — not `currentOrg` — is the mode signal: it is stable from
 * the first frame, so popping back to global search never renders a
 * transient org-scoped frame while the arrival-clear effect runs.
 * Accepted limitation: a shared/typed `/m/search?q=x` URL boots
 * UNSTAMPED and is therefore ordinary in-org search under the resolved
 * org — exactly the pre-5b behavior.
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
  const enterOrg = useEnterOrg();
  const location = useLocation();
  const globalMode = readOrgStamp(location.state) === null;
  const done = useBackOr(globalMode ? '/app' : '/passwords');

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

  // Global mode searches with NO company id; org mode gates on settled
  // scope so a still-resolving null never fires a global query from the
  // in-org screen.
  const searchOrgId = globalMode ? null : (currentOrg?.id ?? null);
  const results = useSearchResults(searchOrgId, debounced, {
    ready: globalMode || (scopeStatus === 'ready' && currentOrg !== null),
  });
  const askVisible = me?.role !== 'CLIENT_USER';
  const { setDraft } = useAsk();

  /**
   * Open a hit. Global hits carry their organization into the
   * destination: one coordinated switch + a push stamped with the hit's
   * org — the detail then renders under that org's header with the tab
   * bar (the "inside a client" chrome transition). `backLabel` keeps the
   * chevron honest: it pops back HERE, so it must say "Search".
   */
  const openHit = (hit: SearchHit, to: string) => {
    if (globalMode) {
      enterOrg(
        {
          id: hit.companyId,
          name: hit.companyName,
          initials: initialsFromName(hit.companyName),
          subtitle: null,
        },
        { to, history: 'push', upIsBack: true, backLabel: 'Search' },
      );
      return;
    }
    navigate({ to, upIsBack: true, backLabel: 'Search' });
  };

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
              // The ONE sanctioned autofocus in the app (Phase 3 locked
              // decision, scoped in Sheet.tsx's docblock): tapping the
              // header's search icon IS the intent to type, and there is
              // no content underneath yet for focus to steal from.
              // eslint-disable-next-line jsx-a11y/no-autofocus
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

        {/* Scope-resolution states are an org-mode concern only: global
            mode's scope is settled by construction (the null stamp). */}
        {!globalMode && scopeStatus === 'resolving' && (
          <SkeletonList rows={5} variant="row" />
        )}

        {!globalMode && scopeStatus === 'error' && (
          <ErrorBanner
            title="Couldn’t load your organizations."
            detail="Check your connection and try again."
            onRetry={retry}
          />
        )}

        {!globalMode && scopeStatus === 'ready' && !currentOrg && (
          <EmptyState message="No organizations available. Ask an administrator to give you access to a client." />
        )}

        {(globalMode || (scopeStatus === 'ready' && currentOrg !== null)) && (
          <>
            {!debounced && (
              <EmptyState
                message={
                  globalMode
                    ? 'Searches passwords, assets, and articles across all your organizations.'
                    : `Searches passwords, assets, and articles in ${currentOrg?.name ?? ''}.`
                }
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
                <EmptyState
                  message={
                    globalMode
                      ? 'No matches in your organizations.'
                      : `No matches in ${currentOrg?.name ?? ''}.`
                  }
                />
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
                      const snippetOrLayout = hit.snippet ? (
                        <Snippet snippet={hit.snippet} />
                      ) : (
                        (hit.layoutName ?? undefined)
                      );
                      return (
                        <ListRow
                          key={`${hit.kind}:${hit.id}`}
                          title={
                            globalMode ? (
                              // Global rows highlight the term IN the
                              // result's own text instead of appending
                              // the snippet as an extra line.
                              <HighlightMatches text={hit.title} query={debounced} />
                            ) : (
                              hit.title
                            )
                          }
                          metaFont="sans"
                          meta={
                            globalMode ? (
                              // Org context PROMINENTLY on every global
                              // hit — the whole point of carrying scope:
                              // accent-toned company name, so
                              // wrong-client mistakes are visible
                              // before the tap. The server snippet
                              // appears ONLY when the title itself
                              // shows no match (a body-only hit —
                              // "Runbook" matching on "Fortinet" in its
                              // body must still show WHY it matched);
                              // a title-matched row keeps the single
                              // company line, per the no-extra-line
                              // decision. "Covers" is ALL tokens, not
                              // any: `fortinet vpn` on a "Fortinet
                              // router" title still owes the evidence
                              // for "vpn".
                              hit.snippet && !titleCoversQuery(hit.title, debounced) ? (
                                <span className="flex min-w-0 flex-col gap-0.5">
                                  <span className="truncate font-medium text-accent-text">
                                    {hit.companyName}
                                  </span>
                                  <Snippet snippet={hit.snippet} />
                                </span>
                              ) : (
                                <span className="truncate font-medium text-accent-text">
                                  {hit.companyName}
                                </span>
                              )
                            ) : (
                              snippetOrLayout
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
                          onClick={to ? () => openHit(hit, to) : undefined}
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
