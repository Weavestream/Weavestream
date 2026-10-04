import type { PasswordAccessUser } from '@weavestream/shared';
import {
  accessSourceLabel,
  accessUserIds,
  pruneUnavailable,
  restrictedIdsToSave,
  toggleSelection,
  unavailableSelection,
  withAlwaysIncluded,
} from './internal-access-selection';

function user(id: string, alwaysIncluded = false): PasswordAccessUser {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    role: alwaysIncluded ? 'SUPER_ADMIN' : 'OPERATOR',
    accessSource: alwaysIncluded ? 'super_admin' : 'membership',
    alwaysIncluded,
  } as PasswordAccessUser;
}

const users = [user('admin', true), user('ana'), user('ben')];
const { selectable, alwaysIncluded } = accessUserIds(users);

describe('accessUserIds', () => {
  it('splits eligible users from the always-included subset', () => {
    expect([...selectable]).toEqual(['admin', 'ana', 'ben']);
    expect([...alwaysIncluded]).toEqual(['admin']);
  });
});

describe('withAlwaysIncluded', () => {
  it('ticks always-included users on load and keeps the saved selection', () => {
    expect([...withAlwaysIncluded(new Set(['ben']), users)].sort()).toEqual(['admin', 'ben']);
  });
});

describe('toggleSelection', () => {
  it('adds and removes an ordinary user', () => {
    const added = toggleSelection(new Set<string>(), 'ana', alwaysIncluded);
    expect([...added]).toEqual(['ana']);
    expect([...toggleSelection(added, 'ana', alwaysIncluded)]).toEqual([]);
  });

  it('never deselects an always-included user', () => {
    const selected = new Set(['admin']);
    expect(toggleSelection(selected, 'admin', alwaysIncluded)).toBe(selected);
  });
});

describe('unavailable users', () => {
  const selected = new Set(['admin', 'ana', 'gone']);

  it('lists selected ids that are no longer eligible', () => {
    expect(unavailableSelection(selected, selectable)).toEqual(['gone']);
  });

  it('prunes them and keeps everyone still eligible', () => {
    expect([...pruneUnavailable(selected, selectable, alwaysIncluded)]).toEqual(['admin', 'ana']);
  });

  it('keeps an always-included id even before the user list has loaded', () => {
    expect([...pruneUnavailable(new Set(['admin']), new Set(), alwaysIncluded)]).toEqual([
      'admin',
    ]);
  });
});

describe('restrictedIdsToSave', () => {
  it('clears the restriction when unrestricted, whatever is ticked', () => {
    expect(restrictedIdsToSave(false, new Set(['ana']), alwaysIncluded)).toEqual([]);
  });

  it('saves the selection plus always-included users, once each', () => {
    expect(restrictedIdsToSave(true, new Set(['ana', 'admin']), alwaysIncluded)).toEqual([
      'ana',
      'admin',
    ]);
    expect(restrictedIdsToSave(true, new Set(['ben']), alwaysIncluded)).toEqual(['ben', 'admin']);
  });

  it('returns nothing when restricted with no one to include', () => {
    expect(restrictedIdsToSave(true, new Set(), new Set())).toEqual([]);
  });
});

describe('accessSourceLabel', () => {
  it.each([
    ['super_admin', 'always included'],
    ['global', 'global access'],
    ['membership', 'membership'],
  ] as const)('labels %s as "%s"', (source, label) => {
    expect(accessSourceLabel(source)).toBe(label);
  });
});
