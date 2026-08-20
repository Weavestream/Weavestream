import type { ArticleSummary, FolderNode } from '../../../../../lib/server-api';

/**
 * What the folder rail has selected, in the same vocabulary `?folderId=`
 * uses: `'all'` (or empty) for everything, `'root'` for articles in no
 * folder, otherwise a folder id.
 */
export type ArticleScope = string;

/** Every folder id the tree carries. */
function knownFolderIds(folders: FolderNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (node: FolderNode) => {
    out.add(node.id);
    for (const child of node.children) walk(child);
  };
  folders.forEach(walk);
  return out;
}

/**
 * The articles a rail selection shows.
 *
 * A folder holds its own articles and nothing else. Opening a parent
 * does not pull its subfolders' articles up into it, the same way no
 * file manager does — these are folders, not saved filters.
 *
 * A folder id that is not in the tree selects nothing. The tree carries
 * only active folders, so this is the archived-folder case: those
 * articles stay reachable under "All articles".
 */
export function scopeArticles(
  articles: ArticleSummary[],
  folders: FolderNode[],
  scope: ArticleScope,
): ArticleSummary[] {
  if (!scope || scope === 'all') return articles;
  if (scope === 'root') return articles.filter((a) => !a.folderId);
  if (!knownFolderIds(folders).has(scope)) return [];
  return articles.filter((a) => a.folderId === scope);
}

/**
 * Every number the rail shows, counted off the same array the list
 * renders — so a count cannot describe a different scope than the rows
 * it sits next to. Both move together when "Show archived" is toggled,
 * because both read the list the server sent for that toggle.
 *
 * A folder's number is its own articles, matching what clicking it
 * opens. A parent does not absorb its children's counts: 4 next to a
 * folder means 4 rows when you click it, whether or not the tree is
 * expanded under it.
 *
 * `all` counts articles whose folder has since been archived, which no
 * folder row can claim. That is not a leak: those rows really are in
 * "All articles", and it is the only place they appear.
 */
export function articleCounts(
  articles: ArticleSummary[],
  folders: FolderNode[],
): { all: number; unfiled: number; byFolder: Map<string, number> } {
  const direct = new Map<string, number>();
  let unfiled = 0;
  for (const a of articles) {
    if (a.folderId === null) unfiled += 1;
    else direct.set(a.folderId, (direct.get(a.folderId) ?? 0) + 1);
  }
  // Walked rather than returned as-is, so every folder in the tree has a
  // number (an empty one reads 0) and folders outside it have none.
  const byFolder = new Map<string, number>();
  const walk = (node: FolderNode) => {
    byFolder.set(node.id, direct.get(node.id) ?? 0);
    for (const child of node.children) walk(child);
  };
  folders.forEach(walk);
  return { all: articles.length, unfiled, byFolder };
}
