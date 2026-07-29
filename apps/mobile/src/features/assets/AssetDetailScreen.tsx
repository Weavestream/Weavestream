import { useRef, useState } from 'react';
import { formatShortDateTime } from '@weavestream/shared';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { DetailHeader } from '../../components/DetailHeader';
import { DeepLinkNotFound } from '../../components/DeepLinkNotFound';
import { Icon } from '../../components/Icon';
import { MetaRow } from '../../components/MetaRow';
import { ShowMore } from '../../components/ShowMore';
import {
  Button,
  Card,
  IconButton,
  Screen,
  Title,
} from '../../components/primitives';
import {
  EmptyState,
  ErrorBanner,
  OfflineBanner,
  SkeletonList,
} from '../../components/states';
import { useToast } from '../../components/Toast';
import { ApiError, isRestrictedError } from '../../lib/api';
import { useOnline } from '../../lib/use-online';
import { useOrgScope } from '../../lib/org-scope';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useCompanyAccess } from '../../lib/use-company-access';
import { UUID_RE } from '../../lib/uuid';
import { deviceTimeZone } from '../../lib/timezone';
import { RelatedSection } from '../relations/RelatedSection';
import { useRelations } from '../relations/queries';
import { AssetFieldRows } from './FieldValueDisplay';
import { LayoutTile } from './LayoutTile';
import { recallListFilter } from './list-filter-memory';
import { provenanceDot, provenanceSummary } from './provenance';
import {
  useArchiveAsset,
  useAssetCredentials,
  useAssetDetail,
  useRestoreAsset,
} from './queries';
import { mergeCredentialGroups } from './related-merge';

const NOT_FOUND_COPY =
  'This asset wasn’t found. It may have been removed, or you may not have access to it.';

/**
 * Asset detail — every layout field in position order, in full (the
 * tier framework never applies to customer-defined fields). Related
 * sits below the fields with the asset's linked credentials folded in
 * as ordinary password rows (locked 2c decision: no dedicated
 * Credentials card). Weavestream's own metadata (actors, timestamps,
 * sync provenance, external identity) is T2 behind ShowMore, whose
 * collapsed label carries the provenance attention dot so a blocked
 * sync is never silently buried.
 *
 * Archived assets render (banner + Restore), never error — the list
 * has no archived view, but direct URLs and stale history still land
 * here, and after archiving from this screen the banner IS the undo.
 *
 * Same validating-wrapper split as ArticleDetailScreen: the malformed
 * deep link renders not-found without mounting hooks.
 */
export function AssetDetailScreen({ assetId }: { assetId: string }) {
  if (!UUID_RE.test(assetId)) {
    return (
      <>
        <DetailHeader backLabel="Assets" backTo="/assets" />
        <Screen>
          <DeepLinkNotFound message={NOT_FOUND_COPY} />
        </Screen>
      </>
    );
  }
  return <AssetDetailLoaded assetId={assetId} />;
}

function AssetDetailLoaded({ assetId }: { assetId: string }) {
  const { currentOrg, scopeStatus, retry } = useOrgScope();
  const online = useOnline();
  const navigate = useScopedNavigate();
  const toast = useToast();
  const { canWrite, isClientUser } = useCompanyAccess();
  const canManage = canWrite && !isClientUser;

  const orgId = currentOrg?.id ?? null;
  const detailQuery = useAssetDetail(orgId, assetId);
  const relationsQuery = useRelations(orgId, 'asset', assetId);
  const credentialsQuery = useAssetCredentials(orgId, assetId);
  const archiveMutation = useArchiveAsset(orgId);
  const restoreMutation = useRestoreAsset(orgId);

  const detail = detailQuery.data;
  const archived = Boolean(detail?.archivedAt);

  // Idempotence guard for archive — a ref, not `isPending`: mutation
  // status propagates on a microtask, so two taps in the same frame
  // would both read stale state and the server 400s the second archive.
  const archiveInFlight = useRef(false);
  // Archive confirms via a sheet (Phase 4); restore stays immediate —
  // it is the undo, and confirming the undo would punish recovery.
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  function onArchive() {
    if (archiveInFlight.current) return;
    archiveInFlight.current = true;
    archiveMutation.mutate(assetId, {
      onSuccess: () => {
        setConfirmingArchive(false);
        toast.push('Asset archived', 'ok');
      },
      // Sheet stays open on failure so retry is one tap.
      onError: () => toast.push('Couldn’t archive asset.', 'danger'),
      onSettled: () => {
        archiveInFlight.current = false;
      },
    });
  }

  function onRestore() {
    restoreMutation.mutate(assetId, {
      onSuccess: () => toast.push('Asset restored', 'ok'),
      onError: () => toast.push('Couldn’t restore asset.', 'danger'),
    });
  }

  const error = detailQuery.error;
  const notFound = error instanceof ApiError && error.status === 404;
  const restricted = isRestrictedError(error);
  const tz = deviceTimeZone();

  // Scope states BEFORE query states — a deep link opened while scope
  // errors must surface that, not a permanent skeleton.
  if (scopeStatus !== 'ready' || !currentOrg) {
    return (
      <>
        <DetailHeader backLabel="Assets" backTo="/assets" />
        <Screen>
          {!online && <OfflineBanner />}
          {scopeStatus === 'resolving' && <SkeletonList rows={4} />}
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
        </Screen>
      </>
    );
  }

  const relatedGroups = relationsQuery.data
    ? mergeCredentialGroups(relationsQuery.data, credentialsQuery.data ?? [])
    : undefined;

  const provSummary = detail ? provenanceSummary(detail.provenance) : null;

  return (
    <>
      <DetailHeader
        backLabel="Assets"
        backTo="/assets"
        backSearch={recallListFilter(orgId)}
        actions={
          detail && !archived && canManage ? (
            <>
              <IconButton
                icon="edit"
                label="Edit asset"
                onClick={() =>
                  navigate({ to: `/assets/${assetId}/edit`, upIsBack: true })
                }
              />
              {/* Opens the confirm sheet (Phase 4). Restore stays
                  immediate on the archived banner this screen keeps
                  showing. */}
              <IconButton
                icon="archive"
                label="Archive asset"
                onClick={() => setConfirmingArchive(true)}
                disabled={archiveMutation.isPending}
              />
            </>
          ) : undefined
        }
      />

      <Screen>
        {!online && <OfflineBanner />}

        {detailQuery.isPending && <SkeletonList rows={4} />}

        {!detailQuery.isPending && notFound && <DeepLinkNotFound message={NOT_FOUND_COPY} />}

        {!detailQuery.isPending && restricted && (
          <ErrorBanner title="You don’t have access to this asset." />
        )}

        {!detailQuery.isPending && error && !notFound && !restricted && (
          <ErrorBanner
            title="Couldn’t load this asset."
            detail="Check your connection and try again."
            onRetry={() => void detailQuery.refetch()}
          />
        )}

        {detail && (
          <>
            <div className="flex flex-col gap-2.25">
              <Title className="leading-[1.15]">{detail.name}</Title>
              <span className="flex items-center gap-2 text-meta text-muted">
                <LayoutTile icon={detail.layoutIcon} color={detail.layoutColor} size={24} />
                {detail.layoutName}
              </span>
            </div>

            {archived && (
              <Card className="flex flex-col gap-3 border-0 bg-warn-soft px-4 py-3.5">
                <span className="flex items-center gap-2 text-body font-medium text-text">
                  <Icon name="archive" size={20} className="text-muted" />
                  This asset is archived.
                </span>
                {canManage && (
                  <Button
                    kind="primary"
                    onClick={onRestore}
                    disabled={restoreMutation.isPending}
                  >
                    {restoreMutation.isPending ? 'Restoring…' : 'Restore'}
                  </Button>
                )}
              </Card>
            )}

            <AssetFieldRows asset={detail} />

            {relatedGroups && <RelatedSection groups={relatedGroups} />}

            <ShowMore dot={provenanceDot(detail.provenance)}>
              <Card className="flex flex-col divide-y divide-line px-4">
                <MetaRow
                  label="Created"
                  value={
                    formatShortDateTime(detail.createdAt, tz) +
                    (detail.createdByUser ? ` · ${detail.createdByUser.name}` : '')
                  }
                />
                <MetaRow
                  label="Updated"
                  value={
                    formatShortDateTime(detail.updatedAt, tz) +
                    (detail.updatedByUser ? ` · ${detail.updatedByUser.name}` : '')
                  }
                />
                {detail.syncSources.map((source) => (
                  <MetaRow
                    key={`${source.integrationId}-${source.resourceKey}`}
                    label="Synced"
                    value={`${source.integrationName} (${source.driver}) · ${formatShortDateTime(source.lastSyncedAt, tz)}`}
                  />
                ))}
                {detail.externalSource !== null && (
                  <MetaRow label="External source" value={detail.externalSource} />
                )}
                {detail.externalId !== null && (
                  <MetaRow label="External ID" value={detail.externalId} />
                )}
                {provSummary && (
                  <MetaRow
                    label="Sync status"
                    value={provSummary.label}
                    tone={provSummary.tone}
                  />
                )}
              </Card>
            </ShowMore>
          </>
        )}
      </Screen>

      <ConfirmSheet
        open={confirmingArchive}
        title="Archive asset?"
        confirmLabel="Archive"
        busy={archiveMutation.isPending}
        onConfirm={onArchive}
        onClose={() => setConfirmingArchive(false)}
      >
        <span className="font-semibold text-text">{detail?.name}</span> will be
        hidden from the default list view. Field values and Relation links are
        preserved and can be restored at any time.
      </ConfirmSheet>
    </>
  );
}
