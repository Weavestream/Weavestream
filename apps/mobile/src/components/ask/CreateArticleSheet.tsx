import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  flattenFolderTree,
  splitMarkdownTitleAndBody,
  type ChatPendingCreate,
} from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import type { Org } from '../../lib/org-scope';
import { useArticleFolders } from '../../features/articles/queries';
import { OrgRow } from '../../features/orgs/OrgRow';
import { useOrgDirectory } from '../../features/orgs/use-org-directory';
import { Icon } from '../Icon';
import { Sheet } from '../Sheet';
import { Button, Field, Input, SectionLabel } from '../primitives';
import { EmptyState, ErrorBanner, SkeletonList } from '../states';
import { useAsk } from './AskProvider';
import type { CreateOverrides } from './chat-actions';
import type { ProposalView } from './proposal-card';

/**
 * Confirmation sheet for `create_article` proposals and update
 * create-promotions (Phase 5b) — mobile's Save-as-article. The user
 * confirms organization, folder, title, and client visibility before
 * anything is applied; the server treats these overrides as canonical
 * so a hallucinated `folder_id` never reaches the articles service.
 *
 * The org rule follows the SERVER contract, not the UI's mood:
 *
 *  - **Company-scoped turn** (`scopeCompanyId` set): the persisted turn
 *    context wins at apply time regardless of the request body, so the
 *    org renders as a LOCKED row — an editable picker would lie.
 *  - **Global turn**: no default; the actor must pick explicitly from
 *    their accessible set (the same directory the launcher renders).
 *  - **`pendingCreate` marker** (a prior apply crashed after creating
 *    the article): EVERYTHING locks to the marker — the original
 *    confirmation is the only one the server will complete, and
 *    mismatched retries are rejected with the stable recovery code.
 *
 * One Sheet, two panes (form ⇄ org list) — never nested sheets, whose
 * stacked focus traps don't compose.
 */
export function CreateArticleSheet({
  open,
  view,
  scopeCompanyId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  view: ProposalView;
  /** The turn's `context.companyId` (null = global turn). */
  scopeCompanyId: string | null;
  onClose: () => void;
  onSubmit: (companyId: string, overrides: CreateOverrides) => Promise<void>;
}) {
  const { state } = useAsk();
  const call = view.call;
  const marker: ChatPendingCreate | undefined = call.pendingCreate;
  const lockedCompanyId = marker?.companyId ?? scopeCompanyId;

  const parsed = useMemo(
    () => splitMarkdownTitleAndBody(view.markdown ?? ''),
    [view.markdown],
  );
  const proposedVisible =
    typeof (call.arguments as Record<string, unknown>).visible_to_clients ===
    'boolean'
      ? ((call.arguments as Record<string, unknown>).visible_to_clients as boolean)
      : false;

  const [pane, setPane] = useState<'form' | 'org'>('form');
  const [pickedOrg, setPickedOrg] = useState<Org | null>(null);
  const [title, setTitle] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [visibleToClients, setVisibleToClients] = useState(false);

  // (Re)seed on every open — and re-lock if a recovery marker appeared
  // (the provider resyncs it in on the recovery-code rejection).
  useEffect(() => {
    if (!open) return;
    setPane('form');
    setPickedOrg(null);
    setTitle(marker?.title ?? view.title ?? parsed.title);
    setFolderId(marker?.folderId ?? null);
    setVisibleToClients(marker?.visibleToClients ?? proposedVisible);
  }, [open, marker, view.title, parsed.title, proposedVisible]);

  const locked = marker !== undefined;
  const chosenCompanyId = lockedCompanyId ?? pickedOrg?.id ?? null;
  const lockedOrgName = useCompanyName(open ? lockedCompanyId : null);
  const orgLabel =
    lockedCompanyId !== null
      ? (lockedOrgName ?? 'Loading…')
      : (pickedOrg?.name ?? null);

  const folders = useArticleFolders(open ? chosenCompanyId : null);
  const flatFolders = useMemo(
    () => flattenFolderTree(folders.data ?? []),
    [folders.data],
  );

  const busy = state.toolAction?.toolCallId === call.id;
  const actionError =
    state.toolActionError?.toolCallId === call.id
      ? state.toolActionError.message
      : null;

  // A settle (applied elsewhere, or our own success) closes the sheet —
  // the card underneath now tells the truth.
  useEffect(() => {
    if (open && call.status !== 'pending') onClose();
  }, [open, call.status, onClose]);

  const body = parsed.body;
  const canSubmit =
    !busy && chosenCompanyId !== null && title.trim().length > 0 && body.trim().length > 0;

  async function submit() {
    if (!canSubmit || chosenCompanyId === null) return;
    await onSubmit(chosenCompanyId, {
      title: marker?.title ?? title.trim(),
      folderId: marker ? marker.folderId : folderId,
      visibleToClients: marker ? marker.visibleToClients : visibleToClients,
    });
    // Success closes via the settle effect; failure keeps the sheet
    // open with the provider's action error inline — never a silent
    // close on a false success.
  }

  if (pane === 'org') {
    return (
      <Sheet open={open} onClose={onClose} title="Choose organization">
        <button
          type="button"
          onClick={() => setPane('form')}
          className="flex h-tap items-center gap-1 self-start text-body font-medium text-accent-text"
        >
          <Icon name="chevron_left" size={20} />
          Back
        </button>
        <OrgPickerPane
          onPick={(org) => {
            setPickedOrg(org);
            setFolderId(null);
            setPane('form');
          }}
        />
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Create article"
      footer={
        <div className="flex gap-2">
          <Button kind="secondary" onClick={onClose} disabled={busy} className="flex-1">
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} className="flex-1">
            {busy ? 'Creating…' : 'Create article'}
          </Button>
        </div>
      }
    >
      {locked && (
        <p className="rounded-field bg-accent-soft p-2.5 text-[13.5px] text-accent-deep">
          A previous apply didn’t finish — completing the original
          confirmation.
        </p>
      )}

      <Field label="Organization" htmlFor="create-article-org">
        {lockedCompanyId !== null ? (
          <div
            id="create-article-org"
            className="flex h-[50px] items-center rounded-field border border-line bg-panel-2 px-4 text-body text-text-2"
          >
            <span className="truncate">{orgLabel}</span>
          </div>
        ) : (
          <button
            id="create-article-org"
            type="button"
            onClick={() => setPane('org')}
            disabled={busy}
            className="flex h-[50px] w-full items-center justify-between rounded-field border border-line bg-surface px-4 text-left text-body"
          >
            <span className={orgLabel ? 'text-text' : 'text-dim'}>
              {orgLabel ?? 'Choose organization'}
            </span>
            <Icon name="chevron_right" size={20} className="text-faint" />
          </button>
        )}
      </Field>

      {chosenCompanyId !== null && (
        <Field label="Folder" htmlFor="create-article-folder">
          <select
            id="create-article-folder"
            value={folderId ?? ''}
            onChange={(e) => setFolderId(e.target.value || null)}
            disabled={busy || locked || folders.isPending}
            className="h-[50px] w-full rounded-field border border-line bg-surface px-3.5 text-body text-text"
          >
            <option value="">— unfiled —</option>
            {flatFolders.map((f) => (
              <option key={f.id} value={f.id}>
                {'· '.repeat(f.depth)}
                {f.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Title" htmlFor="create-article-title">
        <Input
          id="create-article-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Article title"
          maxLength={200}
          disabled={busy || locked}
        />
      </Field>

      <Field label="Visible to clients" htmlFor="create-article-visible">
        <button
          id="create-article-visible"
          type="button"
          role="switch"
          aria-checked={visibleToClients}
          disabled={busy || locked}
          onClick={() => setVisibleToClients((v) => !v)}
          className="flex h-tap w-fit items-center gap-3"
        >
          <span
            aria-hidden
            className={
              'flex h-[30px] w-[52px] shrink-0 items-center rounded-pill p-[3px] transition-colors ' +
              (visibleToClients ? 'justify-end bg-accent' : 'justify-start bg-line')
            }
          >
            <span className="h-6 w-6 rounded-pill bg-surface shadow-sm" />
          </span>
          <span className="text-body text-text">
            {visibleToClients ? 'Yes' : 'No'}
          </span>
        </button>
      </Field>

      {!body.trim() && (
        <p className="text-[13.5px] text-warn">The assistant response is empty.</p>
      )}
      {actionError && (
        <p className="text-[13.5px] text-danger" role="alert">
          {actionError}
        </p>
      )}
    </Sheet>
  );
}

/** The launcher's org directory, reused as the explicit-choice pane. */
function OrgPickerPane({ onPick }: { onPick: (org: Org) => void }) {
  const { pinned, rest, loading, nothingAtAll, companies, stars } =
    useOrgDirectory({ filter: '', enabled: true });

  return (
    <>
      {companies.isError && (
        <ErrorBanner
          title="Couldn’t load organizations."
          onRetry={() => {
            void companies.refetch();
            if (stars.isError) void stars.refetch();
          }}
        />
      )}
      {loading && <SkeletonList rows={5} variant="row" />}
      {nothingAtAll && <EmptyState message="No organizations available." />}
      {pinned.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionLabel>Pinned</SectionLabel>
          {pinned.map((org) => (
            <OrgRow key={org.id} org={org} current={false} onSelect={onPick} />
          ))}
        </section>
      )}
      {rest.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionLabel>All organizations</SectionLabel>
          {rest.map((org) => (
            <OrgRow key={org.id} org={org} current={false} onSelect={onPick} />
          ))}
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
    </>
  );
}

function useCompanyName(companyId: string | null): string | null {
  const query = useQuery({
    queryKey: ['companies', companyId, 'name'],
    queryFn: ({ signal }) =>
      apiFetch<{ id: string; name: string; archivedAt: string | null }>(
        `/companies/${companyId}`,
        { signal },
      ),
    enabled: companyId !== null,
    staleTime: 5 * 60 * 1000,
  });
  return query.data?.name ?? null;
}
