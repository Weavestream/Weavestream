import type { MembershipPasswordAccess, UserRole } from '@weavestream/shared';
import {
  canReadPassword,
  FULL_PASSWORD_ACCESS,
  NO_PASSWORD_ACCESS,
  passesGlobalPasswordPolicy,
  passwordReadWhereFor,
  resolvePasswordAccessScope,
  type GlobalPasswordPolicy,
  type PasswordAccessActor,
  type PasswordAccessScope,
} from './password-access-policy.js';

const ME = 'user-me';
const OTHER = 'user-other';
const CO_X = '00000000-0000-4000-8000-00000000000a';
const CO_Y = '00000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-06-01T00:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');
const FUTURE = new Date('2027-01-01T00:00:00Z');

const ALL_USERS: GlobalPasswordPolicy = { mode: 'all_users', userIds: [] };
const NOBODY: GlobalPasswordPolicy = { mode: 'selected_users', userIds: [] };

function actor(role: UserRole, passwordAccess: PasswordAccessScope): PasswordAccessActor {
  return { id: ME, role, passwordAccess };
}

function scope(
  byDefault: boolean,
  allowCompanyIds: string[] = [],
  denyCompanyIds: string[] = [],
): PasswordAccessScope {
  return { byDefault, allowCompanyIds, denyCompanyIds };
}

const OPEN_X = { companyId: CO_X, visibleToClients: false, restrictedToUserIds: [] as string[] };
const OPEN_Y = { companyId: CO_Y, visibleToClients: false, restrictedToUserIds: [] as string[] };
const MINE_X = { companyId: CO_X, visibleToClients: false, restrictedToUserIds: [ME] };
const THEIRS_X = { companyId: CO_X, visibleToClients: false, restrictedToUserIds: [OTHER] };

describe('passesGlobalPasswordPolicy', () => {
  it.each<[UserRole, 'all_users' | 'selected_users', string[], boolean]>([
    ['OPERATOR', 'all_users', [], true],
    ['OPERATOR', 'selected_users', [], false],
    ['OPERATOR', 'selected_users', [OTHER], false],
    ['OPERATOR', 'selected_users', [ME], true],
    ['CONTRACTOR', 'selected_users', [ME], true],
    ['CONTRACTOR', 'selected_users', [], false],
    // Super admins always pass, listed or not.
    ['SUPER_ADMIN', 'selected_users', [], true],
  ])('%s with %s %j → %s', (role, mode, userIds, expected) => {
    expect(passesGlobalPasswordPolicy({ id: ME, role }, { mode, userIds })).toBe(expected);
  });
});

describe('resolvePasswordAccessScope', () => {
  type MembershipState = 'active' | 'expired' | 'revoked' | 'future-expiry';
  function membership(passwordAccess: MembershipPasswordAccess, state: MembershipState) {
    return {
      companyId: CO_X,
      passwordAccess,
      revokedAt: state === 'revoked' ? PAST : null,
      expiresAt: state === 'expired' ? PAST : state === 'future-expiry' ? FUTURE : null,
    };
  }

  it.each<[GlobalPasswordPolicy, MembershipPasswordAccess, MembershipState, PasswordAccessScope]>([
    [ALL_USERS, 'inherit', 'active', scope(true)],
    [ALL_USERS, 'deny', 'active', scope(true, [], [CO_X])],
    [ALL_USERS, 'deny', 'future-expiry', scope(true, [], [CO_X])],
    // An override ends with its membership.
    [ALL_USERS, 'deny', 'expired', scope(true)],
    [ALL_USERS, 'deny', 'revoked', scope(true)],
    [NOBODY, 'inherit', 'active', scope(false)],
    [NOBODY, 'allow', 'active', scope(false, [CO_X])],
    [NOBODY, 'allow', 'expired', scope(false)],
    [NOBODY, 'allow', 'revoked', scope(false)],
  ])('%j + %s membership (%s) → %j', (policy, access, state, expected) => {
    expect(
      resolvePasswordAccessScope(
        { id: ME, role: 'OPERATOR' },
        policy,
        [membership(access, state)],
        NOW,
      ),
    ).toEqual(expected);
  });

  it('gives super admins and client users full access without overrides', () => {
    const deny = [membership('deny', 'active')];
    expect(resolvePasswordAccessScope({ id: ME, role: 'SUPER_ADMIN' }, NOBODY, deny, NOW)).toBe(
      FULL_PASSWORD_ACCESS,
    );
    expect(resolvePasswordAccessScope({ id: ME, role: 'CLIENT_USER' }, NOBODY, deny, NOW)).toBe(
      FULL_PASSWORD_ACCESS,
    );
  });
});

describe('canReadPassword', () => {
  // [role, scope, row, expected]
  it.each<[UserRole, PasswordAccessScope, typeof OPEN_X, boolean]>([
    // Entry without its own list, no override → the global policy.
    ['OPERATOR', scope(true), OPEN_X, true],
    ['OPERATOR', scope(false), OPEN_X, false],
    ['CONTRACTOR', scope(false), OPEN_X, false],
    // Membership override for the entry's company wins over the global policy.
    ['OPERATOR', scope(true, [], [CO_X]), OPEN_X, false],
    ['OPERATOR', scope(true, [], [CO_X]), OPEN_Y, true],
    ['OPERATOR', scope(false, [CO_X]), OPEN_X, true],
    ['OPERATOR', scope(false, [CO_X]), OPEN_Y, false],
    ['CONTRACTOR', scope(false, [CO_X]), OPEN_X, true],
    // Entry with its own list → only that list, overrides and global ignored.
    ['OPERATOR', scope(true), MINE_X, true],
    ['OPERATOR', scope(false), MINE_X, true],
    ['OPERATOR', scope(true, [], [CO_X]), MINE_X, true],
    ['OPERATOR', scope(true), THEIRS_X, false],
    ['OPERATOR', scope(false, [CO_X]), THEIRS_X, false],
    // Super admins always read.
    ['SUPER_ADMIN', NO_PASSWORD_ACCESS, THEIRS_X, true],
    ['SUPER_ADMIN', scope(false, [], [CO_X]), OPEN_X, true],
  ])('%s %j on %j → %s', (role, s, row, expected) => {
    expect(canReadPassword(actor(role, s), row)).toBe(expected);
  });

  it('governs client users by visibleToClients only', () => {
    const client = actor('CLIENT_USER', scope(false, [], [CO_X]));
    expect(
      canReadPassword(client, { ...OPEN_X, visibleToClients: true, restrictedToUserIds: [OTHER] }),
    ).toBe(true);
    expect(canReadPassword(client, OPEN_X)).toBe(false);
  });
});

describe('passwordReadWhereFor', () => {
  it('keeps unrestricted + own-list entries for a user in the global policy', () => {
    expect(passwordReadWhereFor(actor('OPERATOR', scope(true)))).toEqual({
      OR: [
        { restrictedToUserIds: { isEmpty: true } },
        { restrictedToUserIds: { has: ME } },
      ],
    });
  });

  it('excludes denied companies from unrestricted entries for a user in the global policy', () => {
    expect(passwordReadWhereFor(actor('OPERATOR', scope(true, [CO_Y], [CO_X])))).toEqual({
      OR: [
        { restrictedToUserIds: { isEmpty: true }, companyId: { notIn: [CO_X] } },
        { restrictedToUserIds: { has: ME } },
      ],
    });
  });

  it('keeps only allowed companies for a user outside the global policy', () => {
    expect(passwordReadWhereFor(actor('OPERATOR', scope(false, [CO_X], [CO_Y])))).toEqual({
      OR: [
        { restrictedToUserIds: { isEmpty: true }, companyId: { in: [CO_X] } },
        { restrictedToUserIds: { has: ME } },
      ],
    });
  });

  it('keeps only own-list entries for a user outside the global policy with no allow', () => {
    expect(passwordReadWhereFor(actor('OPERATOR', scope(false, [], [CO_X])))).toEqual({
      restrictedToUserIds: { has: ME },
    });
  });

  it('is unfiltered for super admins and visibleToClients for clients', () => {
    expect(passwordReadWhereFor(actor('SUPER_ADMIN', NO_PASSWORD_ACCESS))).toEqual({});
    expect(passwordReadWhereFor(actor('CLIENT_USER', NO_PASSWORD_ACCESS))).toEqual({
      visibleToClients: true,
    });
  });
});
