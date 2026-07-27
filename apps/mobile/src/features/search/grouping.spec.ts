import type { SearchHit } from '@weavestream/shared';
import { groupHits } from './grouping';

function hit(kind: SearchHit['kind'], id: string): SearchHit {
  return {
    kind,
    id,
    title: `t-${id}`,
    snippet: '',
    companyId: 'c1',
    companyName: 'Org',
    companySlug: 'org',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archivedAt: null,
    href: '/admin/should-never-be-used',
    score: 1,
  };
}

describe('groupHits', () => {
  it('groups in the fixed Passwords, Assets, Articles order with counts', () => {
    const groups = groupHits([
      hit('article', 'a1'),
      hit('password', 'p1'),
      hit('asset', 's1'),
      hit('password', 'p2'),
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'Passwords · 2',
      'Assets · 1',
      'Articles · 1',
    ]);
    // Server relevance order preserved within a group.
    expect(groups[0]!.hits.map((h) => h.id)).toEqual(['p1', 'p2']);
  });

  it('omits empty groups entirely', () => {
    const groups = groupHits([hit('article', 'a1')]);
    expect(groups.map((g) => g.kind)).toEqual(['article']);
  });

  it('drops kinds that have no mobile screen', () => {
    const groups = groupHits([hit('upload', 'u1'), hit('domain', 'd1')]);
    expect(groups).toEqual([]);
  });

  it('returns nothing for no hits', () => {
    expect(groupHits([])).toEqual([]);
  });
});
