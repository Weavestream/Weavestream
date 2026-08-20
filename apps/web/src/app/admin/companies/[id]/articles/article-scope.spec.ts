import type { ArticleSummary, FolderNode } from '../../../../../lib/server-api';
import { articleCounts, scopeArticles } from './article-scope';

function article(
  id: string,
  folderId: string | null,
  archived = false,
): ArticleSummary {
  return {
    id,
    companyId: 'c-1',
    folderId,
    title: id,
    slug: id,
    excerpt: null,
    visibleToClients: true,
    revision: 1,
    archivedAt: archived ? '2026-08-19T00:00:00.000Z' : null,
    createdBy: null,
    updatedBy: null,
    createdByUser: null,
    updatedByUser: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

function folder(
  id: string,
  parentId: string | null,
  children: FolderNode[] = [],
): FolderNode {
  return {
    id,
    name: id,
    slug: id,
    icon: null,
    position: 0,
    parentId,
    archivedAt: null,
    // Deliberately a lie: the rail must not read this. The server's own
    // count excludes archived and unfiled articles, which is the defect
    // these helpers exist to route around.
    articleCount: 999,
    children,
  };
}

/** ops > ops-child, plus a sibling. */
const FOLDERS: FolderNode[] = [
  folder('ops', null, [folder('ops-child', 'ops')]),
  folder('hr', null),
];

const ARTICLES: ArticleSummary[] = [
  article('a-ops', 'ops'),
  article('a-ops-child', 'ops-child'),
  article('a-hr', 'hr'),
  article('a-unfiled-1', null),
  article('a-unfiled-2', null),
];

describe('scopeArticles', () => {
  it('returns everything for the reserved "all" selections', () => {
    expect(scopeArticles(ARTICLES, FOLDERS, 'all')).toHaveLength(5);
    expect(scopeArticles(ARTICLES, FOLDERS, '')).toHaveLength(5);
  });

  it('selects articles in no folder for "root"', () => {
    expect(scopeArticles(ARTICLES, FOLDERS, 'root').map((a) => a.id)).toEqual([
      'a-unfiled-1',
      'a-unfiled-2',
    ]);
  });

  it('shows a folder its own articles, never its subfolders\'', () => {
    expect(scopeArticles(ARTICLES, FOLDERS, 'ops').map((a) => a.id)).toEqual([
      'a-ops',
    ]);
    expect(
      scopeArticles(ARTICLES, FOLDERS, 'ops-child').map((a) => a.id),
    ).toEqual(['a-ops-child']);
  });

  it('selects nothing for a folder that is not in the tree', () => {
    expect(scopeArticles(ARTICLES, FOLDERS, 'gone')).toEqual([]);
  });
});

describe('articleCounts', () => {
  it('counts unfiled articles instead of reporting zero', () => {
    expect(articleCounts(ARTICLES, FOLDERS).unfiled).toBe(2);
  });

  it('counts every article under "all", filed or not', () => {
    expect(articleCounts(ARTICLES, FOLDERS).all).toBe(5);
  });

  it('counts a folder\'s own articles, not its children\'s', () => {
    const { byFolder } = articleCounts(ARTICLES, FOLDERS);
    expect(byFolder.get('ops')).toBe(1);
    expect(byFolder.get('ops-child')).toBe(1);
    expect(byFolder.get('hr')).toBe(1);
  });

  it('gives an empty folder a zero rather than no entry', () => {
    const { byFolder } = articleCounts([article('a-hr', 'hr')], FOLDERS);
    expect(byFolder.get('ops')).toBe(0);
    expect(byFolder.get('ops-child')).toBe(0);
  });

  it('moves with the list when archived articles are included', () => {
    const withArchived = [...ARTICLES, article('a-old', 'hr', true)];
    // The page re-fetches with `includeArchived`, so both the rows and
    // the counts read the longer array — neither can lag the other.
    expect(articleCounts(ARTICLES, FOLDERS).byFolder.get('hr')).toBe(1);
    expect(articleCounts(withArchived, FOLDERS).byFolder.get('hr')).toBe(2);
    expect(articleCounts(withArchived, FOLDERS).all).toBe(6);
  });

  it('agrees with the rows every selection shows', () => {
    const counts = articleCounts(ARTICLES, FOLDERS);
    expect(scopeArticles(ARTICLES, FOLDERS, 'all')).toHaveLength(counts.all);
    expect(scopeArticles(ARTICLES, FOLDERS, 'root')).toHaveLength(
      counts.unfiled,
    );
    for (const id of ['ops', 'ops-child', 'hr']) {
      expect(scopeArticles(ARTICLES, FOLDERS, id)).toHaveLength(
        counts.byFolder.get(id)!,
      );
    }
  });

  it('keeps an article in an archived folder inside "all" only', () => {
    // Archiving a folder with the "archive" cascade leaves its articles
    // pointing at it, and the tree carries active folders only.
    const orphaned = [...ARTICLES, article('a-orphan', 'archived-folder', true)];
    const counts = articleCounts(orphaned, FOLDERS);
    expect(counts.all).toBe(6);
    expect(counts.unfiled).toBe(2);
    expect(counts.byFolder.get('archived-folder')).toBeUndefined();
    expect(scopeArticles(orphaned, FOLDERS, 'all')).toHaveLength(6);
  });
});
