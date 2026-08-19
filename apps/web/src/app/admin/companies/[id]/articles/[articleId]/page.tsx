import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getArticle,
  getCompanyDetail,
  getCompanyFolderTree,
  requireMe,
  getSettings,
  listArticles,
  throwUnlessFound,
} from '../../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../../lib/roles';
import { TopBar } from '../../../../../../components/shell/top-bar';
import { Panel, ShowMore, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';
import { ArticleBody } from '../../../../../../components/editor/article-body';
import { ArticleChatContext } from '../../../../../../components/editor/article-chat-context';
import { ArticleSideNavColumn } from '../../../../../../components/editor/article-side-nav-column';
import { ArticleToc } from '../../../../../../components/editor/article-toc';
import { LinkedItemsPanel } from '../../../../../../components/relations';
import { AttachmentsPanel } from '../../../../../../components/upload/attachments-panel';
import { ArticleHeaderActions } from './article-header-actions';
import {
  ProvenanceBadge,
  provenanceAttention,
} from '../../../../../../components/integrations/provenance-badge';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; articleId: string }>;
}): Promise<Metadata> {
  const { id, articleId } = await params;
  const article = await getArticle(id, articleId);
  return article ? { title: article.title } : {};
}

export default async function ArticleReadPage({
  params,
}: {
  params: Promise<{ id: string; articleId: string }>;
}) {
  const { id: companyId, articleId } = await params;
  const me = await requireMe();
  const term = buildTerm(await getSettings());

  const [companyRes, article, folders, articleList] = await Promise.all([
    getCompanyDetail(companyId),
    getArticle(companyId, articleId),
    getCompanyFolderTree(companyId),
    listArticles(companyId, { includeArchived: false, limit: 500 }),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);
  if (!article) notFound();
  const manage = canWriteCompany(me, company.id);

  return (
    <>
      <ArticleChatContext
        companyId={companyId}
        articleId={article.id}
        title={article.title}
        editorMode={article.editorMode}
        content={article.content}
        markdownSource={article.markdownSource}
        revision={article.revision}
      />
      <TopBar
        crumbs={companyCrumbs(
          term,
          company,
          { label: 'Articles', href: `/admin/companies/${companyId}/articles` },
          { label: article.title },
        )}
        // One row, not two. The article's own actions ride in the
        // breadcrumb row beside the global cluster; the status tags
        // that used to share the old sub-row now sit with the title,
        // where they describe the article rather than the chrome.
        right={
          <ArticleHeaderActions
            companyId={companyId}
            article={{
              id: article.id,
              title: article.title,
              archivedAt: article.archivedAt,
              folderId: article.folderId,
              isStarred: article.isStarred,
              hasDraft: article.hasDraft,
            }}
            manage={manage}
          />
        }
      />

      <div
        className="article-read-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'var(--article-sidenav-w, 240px) 1fr 320px',
          flex: 1,
          minHeight: 0,
        }}
      >
        <ArticleSideNavColumn
          companyId={companyId}
          folders={folders}
          articles={articleList.items}
          activeArticleId={article.id}
        />

        <div className="scroll article-read-main" style={{ overflow: 'auto', minWidth: 0 }}>
          <article
            className="article-read-body"
            style={{
              maxWidth: 1000,
              margin: '0 auto',
              padding: '40px 40px 80px',
            }}
          >
            {(!article.visibleToClients || article.archivedAt) && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexWrap: 'wrap',
                  margin: '0 0 10px',
                }}
              >
                {!article.visibleToClients && <Tag tone="outline">internal</Tag>}
                {article.archivedAt && <Tag tone="warn">archived</Tag>}
              </div>
            )}
            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 34,
                fontWeight: 600,
                letterSpacing: -0.8,
                margin: '0 0 12px',
                lineHeight: 1.1,
              }}
            >
              {article.title}
            </h1>
            <ArticleBody
              editorMode={article.editorMode}
              content={article.content}
              markdownSource={article.markdownSource}
              isAdmin
              fallbackCompanyId={companyId}
            />
          </article>
        </div>

        <aside
          className="scroll article-read-aside"
          style={{
            borderLeft: '1px solid var(--line)',
            padding: '24px 18px',
            overflow: 'auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
          }}
        >
          <div className="article-read-toc" style={{ display: 'contents' }}>
            <ArticleToc
              articleId={article.id}
              articleUpdatedAt={article.updatedAt}
            />
          </div>
          <LinkedItemsPanel
            companyId={companyId}
            entityType="article"
            entityId={article.id}
            editable={manage && !article.archivedAt}
          />
          <AttachmentsPanel
            companyId={companyId}
            entityType="article"
            entityId={article.id}
            editable={manage && !article.archivedAt}
          />
          <ShowMore attention={provenanceAttention(article.provenance)}>
            <Panel title="Last activity">
              <Row label="Created" value={new Date(article.createdAt).toLocaleString()} />
              {article.createdByUser && (
                <Row label="Created by" value={article.createdByUser.name} />
              )}
              <Row
                label="Updated"
                value={new Date(article.updatedAt).toLocaleString()}
                last={!article.updatedByUser}
              />
              {article.updatedByUser && (
                <Row label="Updated by" value={article.updatedByUser.name} last />
              )}
            </Panel>
            {article.provenance.map((provenance) => (
              <ProvenanceBadge
                key={`${provenance.integrationId}:${provenance.resourceId}`}
                provenance={provenance}
              />
            ))}
          </ShowMore>
        </aside>
      </div>
    </>
  );
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        padding: '6px 0',
        borderBottom: last ? 'none' : '1px solid var(--line)',
        fontSize: 12,
      }}
    >
      <span
        style={{
          flex: 1,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          fontSize: 10.5,
        }}
      >
        {label}
      </span>
      <span style={{ color: 'var(--text-2)' }}>{value}</span>
    </div>
  );
}
