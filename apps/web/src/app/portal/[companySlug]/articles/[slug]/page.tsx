import { notFound } from 'next/navigation';
import { getArticleBySlug, getMe } from '../../../../../lib/server-api';
import { TopBar } from '../../../../../components/shell/top-bar';
import { Tag } from '../../../../../components/ui';
import { ArticleBody } from '../../../../../components/editor/article-body';
import { AttachmentsPanel } from '../../../../../components/upload/attachments-panel';

/**
 * Portal article reader.
 *
 * No `LinkedItemsPanel` or `ArticleToc` — the relations API still
 * emits admin-scoped hrefs that would 404 for clients. The
 * read-only Attachments panel is safe: it only lists uploads scoped
 * to this article and mints presigned download URLs.
 */

export default async function PortalArticleReadPage({
  params,
}: {
  params: Promise<{ companySlug: string; slug: string }>;
}) {
  const { companySlug, slug } = await params;
  const me = (await getMe())!;
  const membership = me.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) notFound();
  const article = await getArticleBySlug(membership.company.id, slug);
  if (!article) notFound();

  return (
    <>
      <TopBar
        crumbs={[
          { label: membership.company.name },
          {
            label: 'Articles',
            href: `/portal/${companySlug}/articles`,
          },
          { label: article.title },
        ]}
        right={<>{article.archivedAt && <Tag tone="warn">archived</Tag>}</>}
      />
      <div
        className="article-read-grid"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 300px',
        }}
      >
        <div className="scroll article-read-main" style={{ overflow: 'auto', minWidth: 0 }}>
          <article
            className="article-read-body"
            style={{ maxWidth: 1000, margin: '0 auto', padding: '40px 40px 80px' }}
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
            <div
              style={{
                fontSize: 11,
                color: 'var(--dim)',
                fontFamily: 'var(--font-mono)',
                marginBottom: 30,
              }}
            >
              updated {new Date(article.updatedAt).toLocaleString()}
            </div>
            <ArticleBody
              editorMode={article.editorMode}
              content={article.content}
              markdownSource={article.markdownSource}
              isAdmin={false}
              portalSlugByCompanyId={Object.fromEntries(
                me.memberships.map((m) => [m.company.id, m.company.slug]),
              )}
              fallbackCompanyId={membership.company.id}
            />
          </article>
        </div>
        <aside
          className="scroll article-read-aside"
          style={{
            borderLeft: '1px solid var(--line)',
            padding: '24px 16px',
            overflow: 'auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <AttachmentsPanel
            companyId={membership.company.id}
            entityType="article"
            entityId={article.id}
            editable={false}
          />
        </aside>
      </div>
    </>
  );
}
