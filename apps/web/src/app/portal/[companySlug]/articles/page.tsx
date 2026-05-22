import Link from 'next/link';
import {
  getMe,
  listArticles,
  listFolderTree,
  type ArticleSummary,
  type FolderNode,
} from '../../../../lib/server-api';
import { resolvePortalCompany } from '../../../../lib/portal-company';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Icon, LayoutSwatch, Panel, Tag } from '../../../../components/ui';

/**
 * Portal articles index — read-only for CLIENT_USER. Folder tree mirrors
 * the admin view but without folder/article mutation controls. Internal
 * articles (`visibleToClients=false`) are filtered out server-side by
 * the API since the caller is a CLIENT_* role.
 */
export default async function PortalArticlesPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { companySlug } = await params;
  const sp = await searchParams;
  const me = (await getMe())!;
  const company = await resolvePortalCompany(me, companySlug);
  const companyId = company.id;

  const folderId =
    typeof sp.folderId === 'string' && sp.folderId !== 'all'
      ? sp.folderId
      : undefined;
  const q = typeof sp.q === 'string' ? sp.q : undefined;

  const [folders, page] = await Promise.all([
    listFolderTree(companyId),
    listArticles(companyId, {
      folderId: folderId === 'root' ? null : folderId,
      q,
      limit: 200,
    }),
  ]);

  return (
    <>
      <PageHeader
        crumbs={[
          { label: company.name },
          { label: 'Articles' },
        ]}
        leading={<LayoutSwatch icon="doc" color="var(--accent)" size={48} />}
        title="Knowledge base"
        description="Runbooks, how-tos, and reference material for your workspace."
      />
      <PageBody>
        <Panel
          title={
            <span>
              {page.items.length} article{page.items.length === 1 ? '' : 's'}
            </span>
          }
          noPad
        >
          <PortalArticles
            companySlug={companySlug}
            folders={folders}
            articles={page.items}
            folderId={folderId ?? ''}
            q={q ?? ''}
          />
        </Panel>
      </PageBody>
    </>
  );
}

function PortalArticles({
  companySlug,
  folders,
  articles,
  folderId,
  q,
}: {
  companySlug: string;
  folders: FolderNode[];
  articles: ArticleSummary[];
  folderId: string;
  q: string;
}) {
  const activeFolderId = folderId || 'all';
  const base = `/portal/${companySlug}/articles`;
  return (
    <div
      className="articles-browser-grid"
      style={{ display: 'grid', gridTemplateColumns: '240px 1fr' }}
    >
      <aside
        className="articles-browser-aside"
        style={{
          borderRight: '1px solid var(--line)',
          background: 'var(--surface)',
          padding: '12px 6px',
          minHeight: 400,
          minWidth: 0,
        }}
      >
        <FolderNav base={base} folders={folders} activeId={activeFolderId} />
      </aside>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--panel)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          {q ? `Matching "${q}"` : 'Browse the articles in the selected folder.'}
        </div>
        {articles.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 12.5,
            }}
          >
            No articles yet.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {articles.map((a, i) => (
              <li
                key={a.id}
                style={{
                  padding: '10px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  borderBottom:
                    i === articles.length - 1
                      ? 'none'
                      : '1px solid var(--line)',
                }}
              >
                <Icon.doc size={13} style={{ color: 'var(--dim)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Link
                    href={`${base}/${a.slug}`}
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'inherit',
                      display: 'block',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {a.title}
                  </Link>
                  {a.excerpt && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: 'var(--muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginTop: 2,
                      }}
                    >
                      {a.excerpt}
                    </div>
                  )}
                </div>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    color: 'var(--dim)',
                  }}
                >
                  {new Date(a.updatedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FolderNav({
  base,
  folders,
  activeId,
}: {
  base: string;
  folders: FolderNode[];
  activeId: string;
}) {
  const flat = flatten(folders, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <FolderLink
        href={base}
        label="All articles"
        icon={<Icon.grid size={11} style={{ color: 'var(--dim)' }} />}
        active={activeId === 'all'}
      />
      <FolderLink
        href={`${base}?folderId=root`}
        label="Unfiled"
        icon={<Icon.folder size={11} style={{ color: 'var(--dim)' }} />}
        active={activeId === 'root'}
      />
      <div
        style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: '1px solid var(--line)',
        }}
      >
        {flat.map((f) => (
          <FolderLink
            key={f.id}
            href={`${base}?folderId=${f.id}`}
            label={f.name}
            active={activeId === f.id}
            icon={<Icon.folder size={11} style={{ color: 'var(--dim)' }} />}
            depth={f.depth}
          />
        ))}
      </div>
    </div>
  );
}

function FolderLink({
  href,
  label,
  active,
  icon,
  depth = 0,
}: {
  href: string;
  label: string;
  active: boolean;
  icon: React.ReactNode;
  depth?: number;
}) {
  return (
    <Link
      href={href}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        paddingLeft: 8 + depth * 10,
        fontSize: 12,
        color: active ? 'var(--text)' : 'var(--text-2)',
        background: active ? 'var(--panel-2)' : 'transparent',
        borderRadius: 4,
      }}
    >
      <span style={{ width: 12, display: 'grid', placeItems: 'center' }}>
        {icon}
      </span>
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </Link>
  );
}

function flatten(
  list: FolderNode[],
  depth: number,
): Array<{ id: string; name: string; depth: number }> {
  const out: Array<{ id: string; name: string; depth: number }> = [];
  for (const f of list) {
    out.push({ id: f.id, name: f.name, depth });
    out.push(...flatten(f.children, depth + 1));
  }
  return out;
}
