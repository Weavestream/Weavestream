import type { FolderNode } from '@weavestream/shared';
import { flattenFolderTree } from './folders';

function node(over: Partial<FolderNode> & { id: string; name: string }): FolderNode {
  return {
    companyId: 'c1',
    parentId: null,
    slug: over.name.toLowerCase(),
    icon: null,
    position: 0,
    archivedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    articleCount: 0,
    children: [],
    ...over,
  };
}

describe('flattenFolderTree', () => {
  it('walks DFS pre-order, preserving sibling order, with depths', () => {
    const tree = [
      node({
        id: 'a',
        name: 'Network',
        children: [
          node({ id: 'a1', name: 'Switches', parentId: 'a' }),
          node({
            id: 'a2',
            name: 'Routers',
            parentId: 'a',
            children: [node({ id: 'a2x', name: 'Edge', parentId: 'a2' })],
          }),
        ],
      }),
      node({ id: 'b', name: 'Onboarding' }),
    ];
    expect(flattenFolderTree(tree).map((f) => `${f.depth}:${f.id}`)).toEqual([
      '0:a',
      '1:a1',
      '1:a2',
      '2:a2x',
      '0:b',
    ]);
  });

  it('disambiguates duplicate names via breadcrumb labels', () => {
    const tree = [
      node({
        id: 'net',
        name: 'Network',
        children: [node({ id: 'net-docs', name: 'Docs', parentId: 'net' })],
      }),
      node({
        id: 'srv',
        name: 'Servers',
        children: [node({ id: 'srv-docs', name: 'Docs', parentId: 'srv' })],
      }),
    ];
    const flat = flattenFolderTree(tree);
    expect(flat.find((f) => f.id === 'net-docs')?.label).toBe('Network / Docs');
    expect(flat.find((f) => f.id === 'srv-docs')?.label).toBe('Servers / Docs');
  });

  it('returns an empty list for an empty tree', () => {
    expect(flattenFolderTree([])).toEqual([]);
  });
});
