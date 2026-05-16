import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getArticle,
  getCompanyDetail,
  getCompanyFolderTree,
  getMe,
  getSettings,
  listArticles,
  throwUnlessFound,
} from '../../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../../lib/roles';
import { TopBar } from '../../../../../../components/shell/top-bar';
import { Icon, Panel, StarButton, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';
import { ArticleBody } from '../../../../../../components/editor/article-body';
import { ArticleChatContext } from '../../../../../../components/editor/article-chat-context';
import { ArticleSideNavColumn } from '../../../../../../components/editor/article-side-nav-column';
import { ArticleToc } from '../../../../../../components/editor/article-toc';
import { LinkedItemsPanel } from '../../../../../../components/relations';
import { AttachmentsPanel } from '../../../../../../components/upload/attachments-panel';
import { ArticleActions } from '../article-actions';

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
  const me = (await getMe())!;
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
      />
      <TopBar
        crumbs={companyCrumbs(
          term,
          company,
          { label: 'Articles', href: `/admin/companies/${companyId}/articles` },
          { label: article.title },
        )}
        right={
          <>
            {!article.visibleToClients && <Tag tone="outline">internal</Tag>}
            {article.archivedAt && <Tag tone="warn">archived</Tag>}
            <StarButton
              entityType="article"
              entityId={article.id}
              initialStarred={article.isStarred}
              showLabel
              iconSize={14}
            />
            {manage && (
              <>
                {!article.archivedAt && (
                  <Link
                    href={`/admin/companies/${companyId}/articles/${article.id}/edit`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      height: 28,
                      padding: '0 10px',
                      border: '1px solid var(--line)',
                      background: 'var(--bg)',
                      color: 'var(--text)',
                      borderRadius: 5,
                      fontSize: 12.5,
                      fontWeight: 600,
                    }}
                  >
                    <Icon.edit size={12} />
                    Edit
                  </Link>
                )}
                <ArticleActions
                  article={{
                    id: article.id,
                    companyId,
                    title: article.title,
                    archivedAt: article.archivedAt,
                  }}
                  layout="topbar"
                />
                <Link
                  href={`/admin/companies/${companyId}/articles/new${article.folderId ? `?folderId=${article.folderId}` : ''}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 28,
                    padding: '0 10px',
                    background: 'var(--accent)',
                    color: 'var(--accent-ink)',
                    borderRadius: 5,
                    fontSize: 12.5,
                    fontWeight: 600,
                  }}
                >
                  <Icon.plus size={13} />
                  New article
                </Link>
              </>
            )}
          </>
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
