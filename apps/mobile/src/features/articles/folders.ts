import type { FolderNode } from '@weavestream/shared';

export interface FlatFolder {
  id: string;
  name: string;
  /**
   * Breadcrumb path ("Parent / Child"). Chips and the detail MetaRow
   * show this rather than the bare name — folder names may repeat under
   * different parents, and a chip that just says "Switches" twice is
   * ambiguous.
   */
  label: string;
  depth: number;
}

/**
 * DFS pre-order flatten of the server's folder tree: a parent precedes
 * its children, siblings keep the server's `position asc, name asc`
 * order — the closest flat analogue of the tree for a chip row.
 */
export function flattenFolderTree(nodes: FolderNode[]): FlatFolder[] {
  const out: FlatFolder[] = [];
  function walk(list: FolderNode[], trail: string[], depth: number): void {
    for (const node of list) {
      const label = [...trail, node.name].join(' / ');
      out.push({ id: node.id, name: node.name, label, depth });
      walk(node.children, [...trail, node.name], depth + 1);
    }
  }
  walk(nodes, [], 0);
  return out;
}
