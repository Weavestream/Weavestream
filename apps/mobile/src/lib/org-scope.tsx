import { useQuery, useQueryClient } from '@tanstack/react-query';
import { initialsFromName } from '@weavestream/shared';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, apiFetch } from './api';
import { clearRememberedLocations } from './tab-stacks';
// Shared UUID shape check (`localStorage` is untrusted input).
import { UUID_RE } from './uuid';

/**
 * Which client organization the app is scoped to.
 *
 * **This is a UI convenience, never an authorization input.** Every
 * request is re-authorized server-side against the acting user;
 * `GET /companies` scopes to the caller's live memberships in its own
 * `WHERE` clause, and `company.read` is re-derived per request. Holding
 * an id here is safe precisely because nothing trusts it (CLAUDE.md §1).
 */

const STORAGE_KEY = 'ws_m_org';
const SCOPE_QUERY_KEY = ['org-scope'] as const;

export interface Org {
  id: string;
  name: string;
  initials: string;
  /** Handoff's meta line. The API has no site or password count, and no
   *  `Site` model exists at all, so this is what a row can honestly say. */
  subtitle: string | null;
}

/**
 * `'resolving'` and `'ready'` are not enough on their own, because
 * `currentOrg: null` is overloaded: it is both the legitimate zero-org
 * state *and* the transient value while resolution runs. `'error'` is the
 * transport/5xx branch — the stored id is kept, the guard stands down,
 * and `retry()` returns to `'resolving'`.
 */
export type ScopeStatus = 'resolving' | 'ready' | 'error';

interface OrgScopeValue {
  currentOrg: Org | null;
  scopeStatus: ScopeStatus;
  /** Coordinated switch — see `switchOrg` below for why it is one call. */
  switchOrg: (org: Org) => void;
  /**
   * Leave org context (arriving on the launcher / global search). Clears
   * only the in-memory selection — `localStorage` keeps the last org so
   * cold deep links into scoped routes still resolve (Phase 5b D4);
   * sign-out remains the localStorage-clearing path.
   */
  clearOrg: () => void;
  retry: () => void;
}

const OrgScopeContext = createContext<OrgScopeValue | null>(null);

// ───────────────────────────────────────────────────────────────────
// Persistence
// ───────────────────────────────────────────────────────────────────

function readPersistedOrgId(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // Validate before it is ever interpolated into a URL. The server's
    // `ParseUUIDPipe` would also reject a malformed value, but relying on
    // that means sending untrusted storage content to the API to find out.
    if (!UUID_RE.test(raw)) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return raw;
  } catch {
    // Private mode / storage disabled. No scope preference, not an error.
    return null;
  }
}

function writePersistedOrgId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Losing the preference is a degraded convenience, not a failure —
    // the app works, it just won't remember the org next launch.
  }
}

/**
 * Forget the selected org.
 *
 * Exported for sign-out: a hard reload drops the in-memory query cache,
 * but `localStorage` survives it, so without this the next person to sign
 * in on the device lands in the previous user's client.
 */
export function clearPersistedOrg(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

// ───────────────────────────────────────────────────────────────────
// Wire shapes (the subset actually used)
// ───────────────────────────────────────────────────────────────────

interface CompanyRow {
  id: string;
  name: string;
  archivedAt: string | null;
  type?: string | null;
  city?: string | null;
  region?: string | null;
}

const COMPANY_TYPE_LABEL: Record<string, string> = {
  CLIENT: 'Client',
  PROSPECT: 'Prospect',
  VENDOR: 'Vendor',
  INTERNAL: 'Internal',
  PARTNER: 'Partner',
  OTHER: 'Other',
};

/** Location if the row has one, else the company type. Never invented. */
export function orgSubtitle(row: CompanyRow): string | null {
  const place = [row.city, row.region].filter(Boolean).join(', ');
  if (place) return place;
  return row.type ? (COMPANY_TYPE_LABEL[row.type] ?? null) : null;
}

export function toOrg(row: CompanyRow): Org {
  return {
    id: row.id,
    name: row.name,
    initials: initialsFromName(row.name),
    subtitle: orgSubtitle(row),
  };
}

// ───────────────────────────────────────────────────────────────────
// Resolution
// ───────────────────────────────────────────────────────────────────

/** 4xx outcomes mean "this preference is no longer usable" — clear it and
 *  fall back. Anything else (transport, 5xx) must NOT erase a valid
 *  preference just because the network failed. */
function isTerminalValidationFailure(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.status === 400 || err.status === 403 || err.status === 404)
  );
}

/**
 * Bail out if this resolution has been superseded.
 *
 * Aborting the *request* is not enough on its own, because every branch of
 * `resolveScope` also writes to `localStorage`. A resolution that lost the
 * race to `switchOrg` would otherwise continue past its already-discarded
 * response and persist its own answer over the user's newer choice —
 * leaving the UI showing one client and the next launch opening a
 * different one.
 *
 * Called after every `await`, before any storage mutation or return.
 */
function assertLive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('org scope resolution aborted', 'AbortError');
  }
}

/**
 * Resolve the scope: validate the stored id, else fall back to the first
 * visible org, else null (a user with no visible companies — which
 * `GET /companies` returns as an empty list by design).
 *
 * Validation goes through `GET /companies/:id` rather than looking for
 * the id in the paginated list. The list is alphabetical with a cursor,
 * so "not in the first page" says nothing about access — treating it as
 * revoked would silently reset the scope of anyone whose org sorts late.
 * The detail route is guarded by `company.read`, which any FULL/READONLY
 * effective access satisfies and which is expiry-aware, so it answers the
 * question we are actually asking.
 */
async function resolveScope(signal?: AbortSignal): Promise<Org | null> {
  const storedId = readPersistedOrgId();

  if (storedId) {
    try {
      const row = await apiFetch<CompanyRow>(`/companies/${storedId}`, {
        signal,
      });
      assertLive(signal);
      // 200 is not sufficient: the detail endpoint happily returns an
      // archived company. Scoping the app to one would leave the
      // technician in a client that is no longer being serviced.
      if (row.archivedAt === null) return toOrg(row);
      clearPersistedOrg();
    } catch (err) {
      // Superseded wins over the error itself.
      //
      // A genuine 403 can land in the same tick the user picks a new org —
      // the response was already in flight when the abort fired. Handling it
      // then would run `clearPersistedOrg()` and wipe the id `switchOrg` has
      // *just* written, so the UI would show the chosen client (precedence)
      // while the next launch fell back to the alphabetically-first one.
      // Neither clearing nor falling back is this resolution's job any more.
      assertLive(signal);

      // An abort that surfaced as the rejection itself is likewise not a
      // terminal validation failure, so it rethrows rather than clearing.
      if (!isTerminalValidationFailure(err)) throw err;
      clearPersistedOrg();
    }
  }

  const page = await apiFetch<{ items: CompanyRow[] }>('/companies?limit=1', {
    signal,
  });
  assertLive(signal);
  const first = page.items[0];
  if (!first) return null;
  writePersistedOrgId(first.id);
  return toOrg(first);
}

export function OrgProvider({
  children,
  bootOrgFree = false,
}: {
  children: ReactNode;
  /**
   * Whether the BOOT entry is an org-free surface (launcher, or a
   * reloaded global search carrying the `orgId: null` stamp) — computed
   * by the mounting shell via `isOrgFreeEntry`, because the provider
   * itself deliberately has no router dependency. Read once, in the
   * lazy initializer: later location changes go through `clearOrg` /
   * `switchOrg`, never through this prop.
   */
  bootOrgFree?: boolean;
}) {
  const queryClient = useQueryClient();

  /**
   * An explicit choice, which **outranks** the boot resolution.
   *
   * `undefined` means "nothing chosen this session, use the resolver".
   * `null` means "deliberately no org" — the launcher / global-search
   * state (Phase 5b).
   *
   * An org-free boot starts at `null`, which both renders org-free
   * immediately and — via the `enabled` gate below — keeps the resolver
   * from running at all, so a launcher boot makes zero scope requests
   * and never writes a fallback org to `localStorage`. Scoped-route
   * boots start `undefined` and resolve exactly as before.
   *
   * This is what makes the switch race-free rather than merely
   * cancellation-dependent. The switcher is reachable while the initial
   * resolution is still in flight — the header renders before scope is
   * `'ready'` — and relying on `cancelQueries` to suppress that resolution
   * means relying on TanStack's cancellation semantics: `revert: true`
   * rolls the query back in a microtask *after* a synchronous
   * `setQueryData`, wiping the selection, while `revert: false` records the
   * cancellation as a query error, so the provider reports `'error'` while
   * holding a perfectly good org. Precedence sidesteps both.
   */
  const [selected, setSelected] = useState<Org | null | undefined>(() =>
    bootOrgFree ? null : undefined,
  );

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: SCOPE_QUERY_KEY,
    // `signal` is threaded all the way into `apiFetch` so `switchOrg` can
    // genuinely abort a resolution that is still in flight.
    queryFn: ({ signal }) => resolveScope(signal),
    // Resolution is a boot step, not a live view. Refetching it would
    // fight `switchOrg`'s cache write.
    staleTime: Infinity,
    // Once anything is explicitly selected (an org, or the launcher's
    // deliberate null) the resolver's answer could never be consumed —
    // precedence ignores it — so don't spend the requests.
    enabled: selected === undefined,
  });

  /**
   * One coordinated operation, deliberately not a bare setter.
   *
   * `orgId` is passed to the navigation explicitly from `org.id` by the
   * caller (see `useScopedNavigate`) because a hook closure on this tick
   * still holds the *old* org — a stamp taken from context here would be
   * stale and the guard would immediately bounce the user.
   */
  const switchOrg = useCallback(
    (org: Org) => {
      setSelected(org);
      writePersistedOrgId(org.id);
      // Every remembered tab location belongs to the previous org.
      clearRememberedLocations();

      // Purely an optimisation now that precedence handles correctness:
      // abort the in-flight resolution so its request doesn't finish for
      // nothing. `resolveScope` additionally refuses to touch storage once
      // aborted (`assertLive`), which is the half cancellation cannot do.
      void queryClient.cancelQueries({
        queryKey: SCOPE_QUERY_KEY,
        exact: true,
      });

      // Drop org-scoped reads. Predicate rather than exact keys so a new
      // Phase 2 list doesn't have to remember to register itself here.
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] !== 'org-scope' && q.queryKey[0] !== 'me',
      });
    },
    [queryClient],
  );

  /**
   * Leave org context — the arrival side of the launcher / global
   * search. In-memory only (see the interface doc); deliberately does
   * NOT invalidate org caches: `switchOrg` invalidates on the next
   * entry, so re-entering the same org after a launcher visit is a
   * refetch, not a stale view. Stable identity matters: the guard's
   * arrival-clear effect depends on it and must not re-run on org
   * changes (the select-org-on-launcher race).
   */
  const clearOrg = useCallback(() => {
    setSelected(null);
    void queryClient.cancelQueries({ queryKey: SCOPE_QUERY_KEY, exact: true });
  }, [queryClient]);

  const value = useMemo<OrgScopeValue>(
    () => ({
      currentOrg: selected !== undefined ? selected : (data ?? null),
      scopeStatus:
        // An explicit choice is always resolved, whatever the boot query is
        // still doing or has failed at.
        selected !== undefined
          ? 'ready'
          : isPending
            ? 'resolving'
            : isError
              ? 'error'
              : 'ready',
      switchOrg,
      clearOrg,
      retry: () => void refetch(),
    }),
    [selected, data, isPending, isError, switchOrg, clearOrg, refetch],
  );

  return (
    <OrgScopeContext.Provider value={value}>{children}</OrgScopeContext.Provider>
  );
}

export function useOrgScope(): OrgScopeValue {
  const ctx = useContext(OrgScopeContext);
  if (!ctx) throw new Error('useOrgScope must be used within an OrgProvider');
  return ctx;
}

/**
 * Non-throwing read of the active org id, for components that render
 * both inside and outside the provider (prose renderers in tests).
 * `null` means "no scope here" — callers must degrade, never guess.
 */
export function useCurrentOrgIdOrNull(): string | null {
  return useContext(OrgScopeContext)?.currentOrg?.id ?? null;
}
