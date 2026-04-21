import type { MembershipRole, UserRole } from '@weavestream/shared';
import {
  PermissionService,
  type MembershipSnapshot,
  type PermissionInput,
} from './permission.service.js';
import {
  ActionValues,
  PERMISSIONS,
  type Action,
} from './permissions.js';

/**
 * Exhaustive permission-matrix sweep: every (UserRole × MembershipRole|none ×
 * membership state × Action) must match what the spec in `permissions.ts`
 * declares. The test consults the exact same matrix the production code
 * consults, so the test's job is to catch oversights in the matrix itself
 * (e.g. forgot to list CONTRACTOR for a contractor-capable action) and
 * bugs in the evaluator's branching logic.
 */

const USER_ROLES: UserRole[] = [
  'SUPER_ADMIN',
  'OPERATOR',
  'CONTRACTOR',
  'CLIENT_USER',
];

const MEMBERSHIP_ROLES: (MembershipRole | null)[] = [
  null, // caller has no membership for this company
  'OPERATOR_FULL',
  'OPERATOR_READONLY',
  'CLIENT_ADMIN',
  'CLIENT_VIEWER',
];

type MembershipState = 'active' | 'expired' | 'revoked';
const STATES: MembershipState[] = ['active', 'expired', 'revoked'];

const THE_COMPANY = '00000000-0000-0000-0000-000000000001';
const OTHER_COMPANY = '00000000-0000-0000-0000-000000000002';

function membershipFor(role: MembershipRole | null, state: MembershipState): MembershipSnapshot[] {
  if (!role) return [];
  const base = { companyId: THE_COMPANY, role, expiresAt: null as Date | null, revokedAt: null as Date | null };
  if (state === 'expired') base.expiresAt = new Date('2000-01-01');
  if (state === 'revoked') base.revokedAt = new Date('2000-01-01');
  return [base];
}

function expected(
  user: PermissionInput,
  action: Action,
  memberships: MembershipSnapshot[],
  companyId?: string,
): boolean {
  if (user.role === 'SUPER_ADMIN') return true;
  const rule = PERMISSIONS[action];
  if (rule.scope === 'global') return rule.allowGlobal.includes(user.role);
  if (rule.scope === 'self') return true;
  if (!companyId) return false;
  const active = memberships.find(
    (m) => m.companyId === companyId && !m.revokedAt && (!m.expiresAt || m.expiresAt > new Date()),
  );
  if (!active) return false;
  if (rule.allowGlobal.includes(user.role)) return true;
  return rule.allowMembership.includes(active.role);
}

describe('permission matrix (exhaustive)', () => {
  const mismatches: string[] = [];

  for (const action of ActionValues) {
    for (const userRole of USER_ROLES) {
      for (const mRole of MEMBERSHIP_ROLES) {
        for (const state of STATES) {
          if (mRole === null && state !== 'active') continue; // no-op combo

          const user: PermissionInput = { id: 'u1', role: userRole };
          const memberships = membershipFor(mRole, state);
          const companyId = PERMISSIONS[action].scope === 'company' ? THE_COMPANY : undefined;

          const decision = PermissionService.evaluate(user, action, memberships, { companyId });
          const want = expected(user, action, memberships, companyId);

          if (decision.allowed !== want) {
            mismatches.push(
              `action=${action} userRole=${userRole} mRole=${mRole} state=${state} got=${decision.allowed} want=${want} (${decision.reason ?? ''})`,
            );
          }
        }
      }
    }
  }

  it('matches the declared matrix for every (user × membership × state × action)', () => {
    expect(mismatches).toEqual([]);
  });
});

describe('PermissionService.evaluate', () => {
  const user = (role: UserRole): PermissionInput => ({ id: 'u', role });

  it('SUPER_ADMIN bypasses everything even without memberships', () => {
    for (const action of ActionValues) {
      const d = PermissionService.evaluate(user('SUPER_ADMIN'), action, [], {
        companyId: THE_COMPANY,
      });
      expect(d.allowed).toBe(true);
    }
  });

  it('CONTRACTOR cannot read assets in a company they are not a member of', () => {
    const d = PermissionService.evaluate(user('CONTRACTOR'), 'asset.read', [], {
      companyId: THE_COMPANY,
    });
    expect(d.allowed).toBe(false);
  });

  it('CONTRACTOR can write assets with non-expired membership', () => {
    const m: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'CLIENT_VIEWER', // membership role irrelevant — CONTRACTOR global rule wins
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    };
    const d = PermissionService.evaluate(user('CONTRACTOR'), 'asset.write', [m], {
      companyId: THE_COMPANY,
    });
    expect(d.allowed).toBe(true);
  });

  it('CONTRACTOR with expired membership cannot write assets', () => {
    const m: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'CLIENT_VIEWER',
      expiresAt: new Date('2000-01-01'),
      revokedAt: null,
    };
    const d = PermissionService.evaluate(user('CONTRACTOR'), 'asset.write', [m], {
      companyId: THE_COMPANY,
    });
    expect(d.allowed).toBe(false);
  });

  it('CLIENT_ADMIN cannot manage memberships', () => {
    const m: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'CLIENT_ADMIN',
      expiresAt: null,
      revokedAt: null,
    };
    const d = PermissionService.evaluate(user('CLIENT_USER'), 'membership.manage', [m], {
      companyId: THE_COMPANY,
    });
    expect(d.allowed).toBe(false);
  });

  it('OPERATOR_FULL membership grants asset.write to any global role (except client user)', () => {
    const m: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'OPERATOR_FULL',
      expiresAt: null,
      revokedAt: null,
    };
    // CLIENT_USER with a *bogus* OPERATOR_FULL row shouldn't happen in prod,
    // but the matrix-level check must still resolve: allowMembership wins.
    const d = PermissionService.evaluate(user('CLIENT_USER'), 'asset.write', [m], {
      companyId: THE_COMPANY,
    });
    expect(d.allowed).toBe(true);
  });

  it('OPERATOR without membership cannot access another company', () => {
    const m: MembershipSnapshot = {
      companyId: OTHER_COMPANY,
      role: 'OPERATOR_FULL',
      expiresAt: null,
      revokedAt: null,
    };
    const d = PermissionService.evaluate(user('OPERATOR'), 'asset.read', [m], {
      companyId: THE_COMPANY,
    });
    expect(d.allowed).toBe(false);
  });

  it('company-scoped calls without companyId are denied', () => {
    const d = PermissionService.evaluate(user('OPERATOR'), 'asset.read', [], {});
    expect(d.allowed).toBe(false);
  });

  it('revoked memberships never grant access', () => {
    const m: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'OPERATOR_FULL',
      expiresAt: null,
      revokedAt: new Date('2001-01-01'),
    };
    const d = PermissionService.evaluate(user('OPERATOR'), 'asset.read', [m], {
      companyId: THE_COMPANY,
    });
    expect(d.allowed).toBe(false);
  });

  it('user.manage and company.manage are SUPER_ADMIN only', () => {
    for (const role of ['OPERATOR', 'CONTRACTOR', 'CLIENT_USER'] as UserRole[]) {
      expect(
        PermissionService.evaluate(user(role), 'user.manage', []).allowed,
      ).toBe(false);
      expect(
        PermissionService.evaluate(user(role), 'company.manage', []).allowed,
      ).toBe(false);
    }
    expect(
      PermissionService.evaluate(user('SUPER_ADMIN'), 'user.manage', []).allowed,
    ).toBe(true);
  });

  it('settings.manage is a global SUPER_ADMIN-only action', () => {
    for (const role of ['OPERATOR', 'CONTRACTOR', 'CLIENT_USER'] as UserRole[]) {
      // Even a rich membership set should not help — the scope is global.
      const rich: MembershipSnapshot = {
        companyId: THE_COMPANY,
        role: 'OPERATOR_FULL',
        expiresAt: null,
        revokedAt: null,
      };
      expect(
        PermissionService.evaluate(user(role), 'settings.manage', [rich]).allowed,
      ).toBe(false);
    }
    expect(
      PermissionService.evaluate(user('SUPER_ADMIN'), 'settings.manage', []).allowed,
    ).toBe(true);
  });
});
