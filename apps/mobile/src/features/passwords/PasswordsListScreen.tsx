import { useEffect, useState } from 'react';
import type { PasswordSummary } from '@weavestream/shared';
import { Icon } from '../../components/Icon';
import { ScreenHeader } from '../../components/ScreenHeader';
import { Screen } from '../../components/primitives';
import {
  EmptyState,
  ErrorBanner,
  OfflineBanner,
  SkeletonList,
} from '../../components/states';
import { useToast } from '../../components/Toast';
import { useOnline } from '../../lib/use-online';
import { useOrgScope } from '../../lib/org-scope';
import { useCompanyAccess } from '../../lib/use-company-access';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useOpenOrgSheet } from '../../screens/TabShell';
import { isReasonRequired, revealPassword } from './api';
import { needsAttention } from './attention';
import { consumeUniversalClipboardNotice } from './clipboard-guard';
import { copySecret } from './copy';
import { ApiError, StepUpCancelledError, isRestrictedError } from '../../lib/api';
import { redirectToLogin } from '../../lib/navigate';
import {
  useArchivedPasswords,
  usePasswordFolders,
  usePasswords,
} from './queries';
import { rememberListFilter } from './list-filter-memory';
import { PasswordFilterChips, type PasswordListFilter } from './PasswordFilterChips';
import { PasswordRow } from './PasswordRow';
import { RevealReasonSheet } from './RevealReasonSheet';

/**
 * The passwords tab: 2b's list — header with New, chip filters, card
 * rows whose trailing button reveals+copies without navigating.
 *
 * Filter state lives in the route search (`?folder=`/`?view=`) so
 * back-from-detail lands on the same filtered view; chip taps
 * `replace` so cycling filters doesn't grow history.
 */
export function PasswordsListScreen({ filter }: { filter: PasswordListFilter }) {
  const { currentOrg, scopeStatus, retry } = useOrgScope();
  const openOrgSheet = useOpenOrgSheet();
  const online = useOnline();
  const navigate = useScopedNavigate();
  const toast = useToast();
  const { canWrite, isClientUser } = useCompanyAccess();
  // CLIENT_USERs never get write UI even with a FULL membership: a
  // mobile create can't set visibleToClients, so they'd create a
  // record the server immediately hides from them (see use-company-access).
  const canManage = canWrite && !isClientUser;

  const orgId = currentOrg?.id ?? null;
  const listQuery = usePasswords(orgId);
  const archivedQuery = useArchivedPasswords(orgId, filter.view === 'archived');
  const foldersQuery = usePasswordFolders(orgId);

  // Feed the detail/form screens' structural "up" navigation, so
  // returning to the list re-applies the current filter even when
  // history can't be popped (see use-back.ts).
  useEffect(() => {
    if (orgId) rememberListFilter(orgId, filter);
  }, [orgId, filter]);

  // ── Copy flow ────────────────────────────────────────────────────
  // `reasonFor` doubles as the sheet's open state. `copyBusy` guards
  // the sheet's submit; the plain row-copy path needs no busy state
  // (the button is idempotent and the executor dedupes the request).
  const [reasonFor, setReasonFor] = useState<PasswordSummary | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);

  /**
   * MUST be invoked synchronously from a tap handler — `copySecret`
   * rides that gesture's clipboard permission. No awaits before it.
   */
  function runCopy(password: PasswordSummary, reason?: string): Promise<boolean> {
    if (!orgId) return Promise.resolve(false);
    return copySecret({
      fetch: () =>
        revealPassword(orgId, password.id, reason ? { reason } : undefined).then(
          (r) => r.password,
        ),
    }).then((result) => {
      if (result.ok) {
        toast.push('Password copied', 'ok');
        if (consumeUniversalClipboardNotice()) {
          toast.push('Copied values may sync to your other Apple devices (Universal Clipboard).');
        }
        return true;
      }
      if (result.error instanceof StepUpCancelledError) return false;
      if (result.error instanceof ApiError && result.error.status === 401) {
        // Imperative call — the query-cache 401 handler never sees it,
        // and a dead session must not read as "couldn't copy".
        redirectToLogin();
        return false;
      }
      if (isReasonRequired(result.error)) {
        // Reactive path: the summary predates a flag change.
        setReasonError(null);
        setReasonFor(password);
        return false;
      }
      if (isRestrictedError(result.error)) {
        toast.push('You don’t have access to this credential.', 'danger');
        return false;
      }
      toast.push('Couldn’t copy password.', 'danger');
      return false;
    });
  }

  function onRowCopy(password: PasswordSummary) {
    if (password.requireReasonToView) {
      // Pre-emptive: revealing without a reason would just burn an
      // audited request on a guaranteed 400.
      setReasonError(null);
      setReasonFor(password);
      return;
    }
    void runCopy(password);
  }

  function onReasonSubmit(reason: string) {
    if (!reasonFor) return;
    setCopyBusy(true);
    setReasonError(null);
    // Synchronous start — the sheet's submit tap is the gesture.
    void runCopy(reasonFor, reason).then((ok) => {
      setCopyBusy(false);
      if (ok) setReasonFor(null);
      else setReasonError('Couldn’t copy. Check the reason and try again.');
    });
  }

  // ── Rows for the current filter ──────────────────────────────────
  const showArchived = filter.view === 'archived';
  const activeItems = listQuery.data ?? [];
  const now = Date.now();
  const rows: PasswordSummary[] = showArchived
    ? (archivedQuery.data ?? [])
    : activeItems.filter((p) => {
        if (filter.folder) return p.folderId === filter.folder;
        if (filter.view === 'attention') return needsAttention(p, now);
        return true;
      });

  const pending = showArchived
    ? listQuery.isPending || archivedQuery.isPending
    : listQuery.isPending;
  const loadError = showArchived
    ? (listQuery.error ?? archivedQuery.error)
    : listQuery.error;

  const emptyMessage = showArchived
    ? 'No archived passwords.'
    : filter.view === 'attention'
      ? 'Nothing needs attention.'
      : filter.folder
        ? 'No passwords in this folder.'
        : 'No passwords in this organization yet.';

  const setFilter = (next: PasswordListFilter) =>
    navigate({ to: '/passwords', replace: true, search: { ...next } });

  return (
    <>
      <ScreenHeader
        org={currentOrg}
        onOpenOrgSheet={openOrgSheet}
        title="Passwords"
        action={
          scopeStatus === 'ready' && currentOrg && canManage ? (
            <button
              type="button"
              onClick={() => navigate({ to: '/passwords/new', upIsBack: true })}
              className={
                'flex h-[42px] shrink-0 items-center gap-1.75 rounded-pill ' +
                'bg-accent px-[15px] text-[15px] font-semibold text-accent-ink ' +
                'active:bg-accent-pressed'
              }
            >
              <Icon name="add" size={20} />
              New
            </button>
          ) : undefined
        }
        filters={
          scopeStatus === 'ready' && currentOrg && listQuery.data ? (
            <PasswordFilterChips
              items={activeItems}
              folders={foldersQuery.data ?? []}
              filter={filter}
              onChange={setFilter}
            />
          ) : undefined
        }
      />

      <Screen>
        {!online && <OfflineBanner />}

        {scopeStatus === 'resolving' && <SkeletonList rows={5} />}

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
            {pending && <SkeletonList rows={6} />}

            {!pending && loadError && (
              <ErrorBanner
                title="Couldn’t load passwords."
                detail="Check your connection and try again."
                onRetry={() => {
                  void listQuery.refetch();
                  if (showArchived) void archivedQuery.refetch();
                }}
              />
            )}

            {!pending && !loadError && rows.length === 0 && (
              <EmptyState message={emptyMessage} />
            )}

            {!pending && !loadError && rows.length > 0 && (
              <div className="flex flex-col gap-2">
                {rows.map((p) => (
                  <PasswordRow
                    key={p.id}
                    password={p}
                    // `upIsBack`: pushed straight from the list, so the
                    // detail's "‹ Passwords" may pop history (which also
                    // preserves this exact filtered view).
                    onOpen={() =>
                      navigate({ to: `/passwords/${p.id}`, upIsBack: true })
                    }
                    onCopy={showArchived ? undefined : () => onRowCopy(p)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </Screen>

      <RevealReasonSheet
        open={reasonFor !== null}
        action="copy"
        busy={copyBusy}
        error={reasonError}
        onSubmit={onReasonSubmit}
        onClose={() => setReasonFor(null)}
      />
    </>
  );
}
