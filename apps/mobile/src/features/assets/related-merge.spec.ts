import { mergeCredentialGroups } from './related-merge';
import { makeCredential } from './test-fixtures';
import type { RelatedGroups } from '../relations/api';

function groups(over: Partial<RelatedGroups> = {}): RelatedGroups {
  return { asset: [], article: [], password: [], ...over };
}

describe('mergeCredentialGroups', () => {
  it('folds credentials into the password group as ordinary rows', () => {
    const merged = mergeCredentialGroups(groups(), [
      makeCredential({ id: 'e0000000-0000-4000-8000-0000000000e1', name: 'iDRAC', username: 'root' }),
    ]);
    expect(merged.password).toEqual([
      {
        relationId: 'asset-cred-e0000000-0000-4000-8000-0000000000e1',
        kind: 'password',
        id: 'e0000000-0000-4000-8000-0000000000e1',
        title: 'iDRAC',
        subtitle: 'root',
      },
    ]);
  });

  it('dedupes against relation-born rows by password id (relation row wins)', () => {
    const relationRow = {
      relationId: 'r1',
      kind: 'password' as const,
      id: 'e0000000-0000-4000-8000-0000000000e1',
      title: 'iDRAC (manual link)',
      subtitle: null,
    };
    const merged = mergeCredentialGroups(groups({ password: [relationRow] }), [
      makeCredential({ id: 'e0000000-0000-4000-8000-0000000000e1', name: 'iDRAC' }),
      makeCredential({ id: 'e0000000-0000-4000-8000-0000000000e2', name: 'BMC' }),
    ]);
    expect(merged.password.map((p) => p.relationId)).toEqual([
      'r1',
      'asset-cred-e0000000-0000-4000-8000-0000000000e2',
    ]);
  });

  it('sorts appended credentials by name and keeps relation rows first', () => {
    const merged = mergeCredentialGroups(groups(), [
      makeCredential({ id: 'e0000000-0000-4000-8000-0000000000e2', name: 'zebra' }),
      makeCredential({ id: 'e0000000-0000-4000-8000-0000000000e1', name: 'alpha' }),
    ]);
    expect(merged.password.map((p) => p.title)).toEqual(['alpha', 'zebra']);
  });

  it('returns the same groups object when there is nothing to add', () => {
    const input = groups();
    expect(mergeCredentialGroups(input, [])).toBe(input);
  });

  it('leaves asset/article groups untouched', () => {
    const assetRow = {
      relationId: 'r2',
      kind: 'asset' as const,
      id: 'b0000000-0000-4000-8000-0000000000b9',
      title: 'core-sw',
      subtitle: null,
    };
    const merged = mergeCredentialGroups(groups({ asset: [assetRow] }), [makeCredential()]);
    expect(merged.asset).toEqual([assetRow]);
  });
});
