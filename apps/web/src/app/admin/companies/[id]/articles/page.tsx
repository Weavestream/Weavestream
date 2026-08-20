import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Articles' };
import {
  getCompanyDetail,
  getCompanyFolderTree,
  requireMe,
  getSettings,
  listAllArticles,
  throwUnlessFound,
} from '../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Icon, LayoutSwatch, LinkBtn, Panel, Tag } from '../../../../../components/ui';
import { buildTerm, lower } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { ArticlesBrowser } from './articles-browser';
import { scopeArticles } from './article-scope';

/**
 * Admin articles index — left pane is the nested folder tree, main pane
 * is the list of articles in the selected folder. The `folderId` URL
 * param and `q` both select rather than fetch: the server sends the
 * whole company scope for the current `archived` setting, and the
 * browser narrows it by folder and by title as you type. That is what
 * lets the rail's counts and the list read the same array. Archived
 * articles are opt-in via `?archived=1`. Folder create/rename/archive
 * are executed through `ArticlesBrowser` (client component) so we can
 * reuse the server-rendered tree for initial paint.
 */
export default async function CompanyArticlesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: companyId } = await params;
  const sp = await searchParams;
  const me = await requireMe();
  const term = buildTerm(await getSettings());

  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const folderId =
    typeof sp.folderId === 'string' && sp.folderId !== 'all'
      ? sp.folderId
      : undefined;
  const q = typeof sp.q === 'string' ? sp.q : undefined;
  const includeArchived = sp.archived === '1';

  // Unscoped by folder, and complete rather than a first page: the
  // browser filters by folder and by title on the client, and counts the
  // rail off this same array. A slice, or a per-folder fetch, would put
  // the counts and the rows on different footing again.
  const [folders, page] = await Promise.all([
    getCompanyFolderTree(companyId),
    listAllArticles(companyId, { includeArchived }),
  ]);

  // The header names the selection, not the payload — the rail's own
  // counts come from `articleCounts` over the same rows.
  const inScope = scopeArticles(page.items, folders, folderId ?? 'all');

  const manage = canWriteCompany(me, company.id);

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Articles' })}
        leading={<LayoutSwatch icon="doc" color="var(--accent)" size={48} />}
        title="Knowledge base"
        // description={`Runbooks, guides, and internal documentation scoped to this ${lower(
        //   term.one,
        // )}.`}
        actions={
          manage ? (
            <LinkBtn
              kind="primary"
              size="md"
              icon={<Icon.plus size={13} />}
              href={`/admin/companies/${companyId}/articles/new${folderId ? `?folderId=${folderId}` : ''}`}
            >
              New article
            </LinkBtn>
          ) : null
        }
      />
      <PageBody>
        <Panel
          title={
            <span>
              {inScope.length}
              {page.truncated ? '+' : ''} article
              {inScope.length === 1 ? '' : 's'}
              {includeArchived && (
                <Tag tone="outline" style={{ marginLeft: 10 }}>
                  incl. archived
                </Tag>
              )}
              {page.truncated && (
                <Tag tone="warn" style={{ marginLeft: 10 }}>
                  search covers the first {page.items.length}
                </Tag>
              )}
            </span>
          }
          noPad
          fillHeight
        >
          <ArticlesBrowser
            companyId={companyId}
            folders={folders}
            articles={page.items}
            q={q ?? ''}
            folderId={folderId ?? ''}
            includeArchived={includeArchived}
            canManage={manage}
            showCounts={me.preferences.showItemCounts}
          />
        </Panel>
      </PageBody>
    </>
  );
}
