import { formatShortDateTime } from '@weavestream/shared';
import { DetailHeader } from '../../components/DetailHeader';
import { DeepLinkNotFound } from '../../components/DeepLinkNotFound';
import { Icon } from '../../components/Icon';
import { MetaRow } from '../../components/MetaRow';
import { ShowMore } from '../../components/ShowMore';
import { Card, Screen, Title } from '../../components/primitives';
import {
  EmptyState,
  ErrorBanner,
  OfflineBanner,
  SkeletonList,
} from '../../components/states';
import { ApiError, isRestrictedError } from '../../lib/api';
import { useOnline } from '../../lib/use-online';
import { useOrgScope } from '../../lib/org-scope';
import { UUID_RE } from '../../lib/uuid';
import { deviceTimeZone } from '../../lib/timezone';
import { AttachmentsSection } from '../attachments/AttachmentsSection';
import { RelatedSection } from '../relations/RelatedSection';
import { useRelations } from '../relations/queries';
import { ArticleBodyView } from './ArticleBodyView';
import { flattenFolderTree } from './folders';
import { recallListFilter } from './list-filter-memory';
import { useArticleDetail, useArticleFolders } from './queries';

const NOT_FOUND_COPY =
  'This article wasn’t found. It may have been removed, or you may not have access to it.';

/**
 * Article reader — T1 is title, badges, and the body; the whole point
 * of opening a runbook onsite. Related and Attachments sit below the
 * body (linked items and files are primary content, never inside a
 * disclosure — ShowMore doctrine), and the T2 metadata (folder,
 * updated, created) collapses behind ShowMore with no attention dot
 * (articles have no attention concept). Editing, drafts, version
 * history — and attaching or removing a file — are desktop work; the
 * attachments here are read-only like the rest of the screen.
 *
 * Split into a validating wrapper + a hook-owning body: the wrapper
 * must render the not-found state for a malformed deep link WITHOUT
 * mounting any hooks — an early return above hooks would break hook
 * ordering, and mounting them first would fire folder/relations
 * requests for an id that can't exist.
 */
export function ArticleDetailScreen({ articleId }: { articleId: string }) {
  if (!UUID_RE.test(articleId)) {
    return (
      <>
        <DetailHeader backLabel="Articles" backTo="/articles" />
        <Screen>
          <DeepLinkNotFound message={NOT_FOUND_COPY} />
        </Screen>
      </>
    );
  }
  return <ArticleDetailLoaded articleId={articleId} />;
}

function ArticleDetailLoaded({ articleId }: { articleId: string }) {
  const { currentOrg, scopeStatus, retry } = useOrgScope();
  const online = useOnline();

  const orgId = currentOrg?.id ?? null;
  const detailQuery = useArticleDetail(orgId, articleId);
  const relationsQuery = useRelations(orgId, 'article', articleId);
  const foldersQuery = useArticleFolders(orgId);

  const detail = detailQuery.data;
  const error = detailQuery.error;
  const notFound = error instanceof ApiError && error.status === 404;
  const restricted = isRestrictedError(error);

  const tz = deviceTimeZone();
  const folderLabel =
    detail?.folderId != null
      ? (flattenFolderTree(foldersQuery.data ?? []).find(
          (f) => f.id === detail.folderId,
        )?.label ?? '—')
      : '—';

  // Scope states come BEFORE query states: with no resolved org the
  // queries stay `enabled: false` and `isPending` forever — a deep link
  // opened while the scope errors (or resolves to no orgs) must surface
  // that, not a permanent skeleton.
  if (scopeStatus !== 'ready' || !currentOrg) {
    return (
      <>
        <DetailHeader backLabel="Articles" backTo="/articles" />
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

  return (
    <>
      <DetailHeader
        backLabel="Articles"
        backTo="/articles"
        backSearch={recallListFilter(orgId)}
      />

      <Screen>
        {!online && <OfflineBanner />}

        {detailQuery.isPending && <SkeletonList rows={4} />}

        {!detailQuery.isPending && notFound && <DeepLinkNotFound message={NOT_FOUND_COPY} />}

        {!detailQuery.isPending && restricted && (
          <ErrorBanner title="You don’t have access to this article." />
        )}

        {!detailQuery.isPending && error && !notFound && !restricted && (
          <ErrorBanner
            title="Couldn’t load this article."
            detail="Check your connection and try again."
            onRetry={() => void detailQuery.refetch()}
          />
        )}

        {detail && (
          <>
            <div className="flex flex-col gap-2.25">
              <Title className="leading-[1.15]">{detail.title}</Title>

              {(detail.archivedAt !== null || !detail.visibleToClients) && (
                <div className="flex flex-wrap items-center gap-2">
                  {/* The list never shows archived, and Related can't
                      either (the relations service filters archived
                      counterparts) — but a direct URL, stale history
                      entry, or old bookmark still lands here. Render,
                      don't error. An archived runbook is an obsolete
                      procedure; the badge is what keeps a tech from
                      following it cold. */}
                  {detail.archivedAt !== null && (
                    <span className="flex items-center gap-1.5 rounded-[7px] bg-warn-soft px-2.25 py-1 text-[13px] font-medium text-warn">
                      <Icon name="archive" size={15} />
                      Archived
                    </span>
                  )}
                  {/* Only operators can ever load a hidden article (the
                      server 404s client users), so this badge is the
                      "don't show this one to the customer" signal. */}
                  {!detail.visibleToClients && (
                    <span className="flex items-center gap-1.5 rounded-[7px] bg-panel-2 px-2.25 py-1 text-[13px] font-medium text-muted">
                      <Icon name="visibility_off" size={15} />
                      Internal
                    </span>
                  )}
                </div>
              )}
            </div>

            <ArticleBodyView article={detail} />

            {relationsQuery.data && <RelatedSection groups={relationsQuery.data} />}

            <AttachmentsSection
              companyId={orgId}
              entityType="article"
              entityId={articleId}
            />

            <ShowMore dot={null}>
              <Card className="flex flex-col divide-y divide-line px-4">
                <MetaRow label="Folder" value={folderLabel} />
                <MetaRow
                  label="Updated"
                  value={
                    formatShortDateTime(detail.updatedAt, tz) +
                    (detail.updatedByUser ? ` · ${detail.updatedByUser.name}` : '')
                  }
                />
                <MetaRow
                  label="Created"
                  value={
                    formatShortDateTime(detail.createdAt, tz) +
                    (detail.createdByUser ? ` · ${detail.createdByUser.name}` : '')
                  }
                />
              </Card>
            </ShowMore>
          </>
        )}
      </Screen>
    </>
  );
}
