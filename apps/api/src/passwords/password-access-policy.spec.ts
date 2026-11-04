import type { UserRole } from '@weavestream/shared';
import {
  canReadPassword,
  passesGlobalPasswordPolicy,
  passwordReadWhereFor,
  type PasswordAccessActor,
} from './password-access-policy.js';

const ME = 'user-me';
const OTHER = 'user-other';

function actor(role: UserRole, globalPasswordAccess: boolean): PasswordAccessActor {
  return { id: ME, role, globalPasswordAccess };
}

const OPEN = { visibleToClients: false, restrictedToUserIds: [] as string[] };
const MINE = { visibleToClients: false, restrictedToUserIds: [ME] };
const THEIRS = { visibleToClients: false, restrictedToUserIds: [OTHER] };

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

describe('canReadPassword', () => {
  // [role, passes global policy, row, expected]
  it.each<[UserRole, boolean, typeof OPEN, boolean]>([
    // Entry without its own list → follows the global policy.
    ['OPERATOR', true, OPEN, true],
    ['OPERATOR', false, OPEN, false],
    ['CONTRACTOR', false, OPEN, false],
    // Entry with its own list → only that list, global policy ignored.
    ['OPERATOR', true, MINE, true],
    ['OPERATOR', false, MINE, true],
    ['OPERATOR', true, THEIRS, false],
    ['OPERATOR', false, THEIRS, false],
    // Super admins always read.
    ['SUPER_ADMIN', false, THEIRS, true],
    ['SUPER_ADMIN', false, OPEN, true],
  ])('%s (global=%s) on %j → %s', (role, global, row, expected) => {
    expect(canReadPassword(actor(role, global), row)).toBe(expected);
  });

  it('governs client users by visibleToClients only', () => {
    const client = actor('CLIENT_USER', false);
    expect(canReadPassword(client, { visibleToClients: true, restrictedToUserIds: [OTHER] })).toBe(true);
    expect(canReadPassword(client, { visibleToClients: false, restrictedToUserIds: [] })).toBe(false);
  });
});

describe('passwordReadWhereFor', () => {
  it('keeps unrestricted + own-list entries for a user in the global policy', () => {
    expect(passwordReadWhereFor(actor('OPERATOR', true))).toEqual({
      OR: [
        { restrictedToUserIds: { isEmpty: true } },
        { restrictedToUserIds: { has: ME } },
      ],
    });
  });

  it('keeps only own-list entries for a user outside the global policy', () => {
    expect(passwordReadWhereFor(actor('OPERATOR', false))).toEqual({
      restrictedToUserIds: { has: ME },
    });
  });

  it('is unfiltered for super admins and visibleToClients for clients', () => {
    expect(passwordReadWhereFor(actor('SUPER_ADMIN', false))).toEqual({});
    expect(passwordReadWhereFor(actor('CLIENT_USER', false))).toEqual({ visibleToClients: true });
  });
});
