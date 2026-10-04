import type { PasswordVersionSummary } from '@weavestream/shared';
import { sortVersionsNewestFirst, visibleVersions } from './version-history-order';

const v = (version: number) => ({ version }) as PasswordVersionSummary;

describe('version history order', () => {
  it('sorts newest first without mutating the input', () => {
    const versions = [v(2), v(5), v(1)];
    expect(sortVersionsNewestFirst(versions).map((x) => x.version)).toEqual([5, 2, 1]);
    expect(versions.map((x) => x.version)).toEqual([2, 5, 1]);
  });

  it('shows only the latest version while collapsed, and all when expanded', () => {
    const sorted = sortVersionsNewestFirst([v(1), v(3), v(2)]);
    expect(visibleVersions(sorted, false).map((x) => x.version)).toEqual([3]);
    expect(visibleVersions(sorted, true).map((x) => x.version)).toEqual([3, 2, 1]);
  });

  it('shows nothing for a credential with no versions', () => {
    expect(visibleVersions(sortVersionsNewestFirst([]), false)).toEqual([]);
  });
});
