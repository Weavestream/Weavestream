import type {
  GlobalAccess,
  MembershipRole,
  PlatformCapability,
  UserRole,
} from '@weavestream/shared';
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
 * RBAC truth table for the simplified two-axis model. Every
 * (UserRole × globalAccess × capability subset × MembershipRole|none ×
 * state × action) tuple computed by `PermissionService.evaluate` is
 * compared to a deliberately-independent reference implementation
 * (`expected`). Mismatches indicate either a matrix oversight in
 * `permissions.ts` or a divergence in the evaluator branch logic.
 *
 * Phase R1 — replaces the legacy four-value MembershipRole sweep with
 * a leaner sweep that focuses on:
 *   - SUPER_ADMIN bypass
 *   - capability gates (every previously-SA-only action)
 *   - membership > globalAccess precedence
 *   - effective NONE deny path
 */

const USER_ROLES: UserRole[] = [
  'SUPER_ADMIN',
  'OPERATOR',
  'CONTRACTOR',
  'CLIENT_USER',
];

const MEMBERSHIP_ROLES: (MembershipRole | null)[] = [null, 'FULL', 'READONLY'];
const GLOBAL_ACCESSES: GlobalAccess[] = ['FULL', 'READONLY', 'NONE'];

type MembershipState = 'active' | 'expired' | 'revoked';
const STATES: MembershipState[] = ['active', 'expired', 'revoked'];

const THE_COMPANY = '00000000-0000-0000-0000-000000000001';
const OTHER_COMPANY = '00000000-0000-0000-0000-000000000002';

function membershipFor(
  role: MembershipRole | null,
  state: MembershipState,
): MembershipSnapshot[] {
  if (!role) return [];
  const base = {
    companyId: THE_COMPANY,
    role,
    expiresAt: null as Date | null,
    revokedAt: null as Date | null,
  };
  if (state === 'expired') base.expiresAt = new Date('2000-01-01');
  if (state === 'revoked') base.revokedAt = new Date('2000-01-01');
  return [base];
}

function buildUser(
  role: UserRole,
  globalAccess: GlobalAccess | null = null,
  caps: PlatformCapability[] = [],
): PermissionInput {
  return {
    id: 'u',
    role,
    globalAccess,
    platformCapabilities: caps,
  };
}

/** Reference implementation. */
function expected(
  user: PermissionInput,
  action: Action,
  memberships: MembershipSnapshot[],
  companyId?: string,
): boolean {
  if (user.role === 'SUPER_ADMIN') return true;
  const rule = PERMISSIONS[action];

  if (rule.requiredCapability) {
    if (!user.platformCapabilities.includes(rule.requiredCapability)) {
      return false;
    }
    if (rule.scope === 'company' && !companyId) return false;
    return true;
  }

  if (rule.scope === 'global') return false;
  if (rule.scope === 'self') return true;
  if (!companyId) return false;

  const active = memberships.find(
    (m) =>
      m.companyId === companyId &&
      !m.revokedAt &&
      (!m.expiresAt || m.expiresAt > new Date()),
  );
  let effective: GlobalAccess | null;
  if (active) {
    effective = active.role;
  } else if (user.role === 'OPERATOR') {
    effective = user.globalAccess ?? 'NONE';
  } else {
    effective = null;
  }
  if (effective === null || effective === 'NONE') return false;
  if (effective === 'FULL' && rule.allowFull) return true;
  if (effective === 'READONLY' && rule.allowReadonly) return true;
  return false;
}

describe('permission matrix (exhaustive)', () => {
  const mismatches: string[] = [];

  for (const action of ActionValues) {
    const rule = PERMISSIONS[action];
    // For each rule we sweep:
    //   - capability holder (only meaningful for capability rules)
    //   - non-capability holder
    // Combined with role × globalAccess × membership × state.
    const capabilityVariants: (PlatformCapability[] | null)[] = rule.requiredCapability
      ? [[], [rule.requiredCapability]]
      : [[]];

    for (const userRole of USER_ROLES) {
      const globalVariants: (GlobalAccess | null)[] =
        userRole === 'OPERATOR' ? GLOBAL_ACCESSES : [null];
      for (const globalAccess of globalVariants) {
        for (const caps of capabilityVariants) {
          for (const mRole of MEMBERSHIP_ROLES) {
            for (const state of STATES) {
              if (mRole === null && state !== 'active') continue;

              const user = buildUser(userRole, globalAccess, caps ?? []);
              const memberships = membershipFor(mRole, state);
              const companyId =
                rule.scope === 'company' ? THE_COMPANY : undefined;

              const decision = PermissionService.evaluate(
                user,
                action,
                memberships,
                { companyId },
              );
              const want = expected(user, action, memberships, companyId);

              if (decision.allowed !== want) {
                mismatches.push(
                  `action=${action} userRole=${userRole} ga=${globalAccess ?? '∅'} caps=[${caps?.join(',') ?? ''}] mRole=${mRole ?? '∅'} state=${state} got=${decision.allowed} want=${want} (${decision.reason ?? ''})`,
                );
              }
            }
          }
        }
      }
    }
  }

  it('matches the declared matrix for every (user × access × cap × membership × state × action)', () => {
    expect(mismatches).toEqual([]);
  });
});

describe('PermissionService.evaluate — semantic checks', () => {
  it('SUPER_ADMIN bypasses every action even without memberships or capabilities', () => {
    for (const action of ActionValues) {
      const d = PermissionService.evaluate(
        buildUser('SUPER_ADMIN'),
        action,
        [],
        { companyId: THE_COMPANY },
      );
      expect(d.allowed).toBe(true);
    }
  });

  it('CONTRACTOR cannot read assets without a membership for the target company', () => {
    const d = PermissionService.evaluate(
      buildUser('CONTRACTOR'),
      'asset.read',
      [],
      { companyId: THE_COMPANY },
    );
    expect(d.allowed).toBe(false);
  });

  it('CONTRACTOR with active READONLY membership can read but not write', () => {
    const m: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'READONLY',
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    };
    const ctx = { companyId: THE_COMPANY };
    expect(
      PermissionService.evaluate(
        buildUser('CONTRACTOR'),
        'asset.read',
        [m],
        ctx,
      ).allowed,
    ).toBe(true);
    expect(
      PermissionService.evaluate(
        buildUser('CONTRACTOR'),
        'asset.write',
        [m],
        ctx,
      ).allowed,
    ).toBe(false);
  });

  it('Membership wins over globalAccess (READONLY membership downgrades a globalAccess=FULL operator)', () => {
    const m: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'READONLY',
      expiresAt: null,
      revokedAt: null,
    };
    const op = buildUser('OPERATOR', 'FULL');
    expect(
      PermissionService.evaluate(op, 'asset.write', [m], {
        companyId: THE_COMPANY,
      }).allowed,
    ).toBe(false);
    expect(
      PermissionService.evaluate(op, 'asset.read', [m], {
        companyId: THE_COMPANY,
      }).allowed,
    ).toBe(true);
  });

  it('OPERATOR globalAccess=NONE denies even reads when no membership exists', () => {
    const op = buildUser('OPERATOR', 'NONE');
    expect(
      PermissionService.evaluate(op, 'asset.read', [], {
        companyId: THE_COMPANY,
      }).allowed,
    ).toBe(false);
  });

  it('OPERATOR globalAccess=NONE still works for companies they have a membership for', () => {
    const m: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'FULL',
      expiresAt: null,
      revokedAt: null,
    };
    const op = buildUser('OPERATOR', 'NONE');
    expect(
      PermissionService.evaluate(op, 'asset.write', [m], {
        companyId: THE_COMPANY,
      }).allowed,
    ).toBe(true);
  });

  it('Revoked memberships fall back to globalAccess for OPERATOR', () => {
    const revoked: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'FULL',
      expiresAt: null,
      revokedAt: new Date('2001-01-01'),
    };
    const op = buildUser('OPERATOR', 'READONLY');
    expect(
      PermissionService.evaluate(op, 'asset.write', [revoked], {
        companyId: THE_COMPANY,
      }).allowed,
    ).toBe(false);
    expect(
      PermissionService.evaluate(op, 'asset.read', [revoked], {
        companyId: THE_COMPANY,
      }).allowed,
    ).toBe(true);
  });

  it('OPERATOR without membership cannot access another company even with FULL membership elsewhere', () => {
    const m: MembershipSnapshot = {
      companyId: OTHER_COMPANY,
      role: 'FULL',
      expiresAt: null,
      revokedAt: null,
    };
    const op = buildUser('OPERATOR', 'NONE');
    expect(
      PermissionService.evaluate(op, 'asset.read', [m], {
        companyId: THE_COMPANY,
      }).allowed,
    ).toBe(false);
  });

  it('Company-scoped calls without companyId are denied', () => {
    expect(
      PermissionService.evaluate(
        buildUser('OPERATOR', 'FULL'),
        'asset.read',
        [],
        {},
      ).allowed,
    ).toBe(false);
  });

  it('user.manage requires USER_MANAGE for non-SUPER_ADMIN', () => {
    expect(
      PermissionService.evaluate(buildUser('OPERATOR', 'FULL'), 'user.manage', []).allowed,
    ).toBe(false);
    expect(
      PermissionService.evaluate(
        buildUser('OPERATOR', 'FULL', ['USER_MANAGE']),
        'user.manage',
        [],
      ).allowed,
    ).toBe(true);
    expect(
      PermissionService.evaluate(buildUser('SUPER_ADMIN'), 'user.manage', []).allowed,
    ).toBe(true);
  });

  it('integration.manage / sync.trigger require INTEGRATION_MANAGE', () => {
    const op = buildUser('OPERATOR', 'FULL', ['INTEGRATION_MANAGE']);
    const opPlain = buildUser('OPERATOR', 'FULL');
    expect(
      PermissionService.evaluate(op, 'integration.manage', []).allowed,
    ).toBe(true);
    expect(
      PermissionService.evaluate(op, 'sync.trigger', []).allowed,
    ).toBe(true);
    expect(
      PermissionService.evaluate(opPlain, 'integration.manage', []).allowed,
    ).toBe(false);
  });

  it('membership.manage requires MEMBERSHIP_MANAGE and a companyId', () => {
    const op = buildUser('OPERATOR', 'FULL', ['MEMBERSHIP_MANAGE']);
    expect(
      PermissionService.evaluate(op, 'membership.manage', [], {
        companyId: THE_COMPANY,
      }).allowed,
    ).toBe(true);
    expect(
      PermissionService.evaluate(op, 'membership.manage', []).allowed,
    ).toBe(false);
  });

  it('audit.read is global: capability holder can list without a companyId', () => {
    const op = buildUser('OPERATOR', 'NONE', ['AUDIT_READ']);
    expect(
      PermissionService.evaluate(op, 'audit.read', []).allowed,
    ).toBe(true);
    expect(
      PermissionService.evaluate(op, 'audit.read', [], {
        companyId: THE_COMPANY,
      }).allowed,
    ).toBe(true);
  });

  it('settings.manage and export.create require their respective capabilities', () => {
    const op = buildUser('OPERATOR', 'FULL', [
      'SETTINGS_MANAGE',
      'EXPORT_CREATE',
    ]);
    const opPlain = buildUser('OPERATOR', 'FULL');
    expect(
      PermissionService.evaluate(op, 'settings.manage', []).allowed,
    ).toBe(true);
    expect(
      PermissionService.evaluate(op, 'export.create', []).allowed,
    ).toBe(true);
    expect(
      PermissionService.evaluate(opPlain, 'settings.manage', []).allowed,
    ).toBe(false);
    expect(
      PermissionService.evaluate(opPlain, 'export.create', []).allowed,
    ).toBe(false);
  });

  it('layout.manage.global requires LAYOUT_MANAGE for OPERATOR', () => {
    expect(
      PermissionService.evaluate(
        buildUser('OPERATOR', 'FULL', ['LAYOUT_MANAGE']),
        'layout.manage.global',
        [],
      ).allowed,
    ).toBe(true);
    expect(
      PermissionService.evaluate(
        buildUser('OPERATOR', 'FULL'),
        'layout.manage.global',
        [],
      ).allowed,
    ).toBe(false);
  });

  it('CLIENT_USER cannot manage memberships even with a FULL row (defensive)', () => {
    const m: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'FULL',
      expiresAt: null,
      revokedAt: null,
    };
    expect(
      PermissionService.evaluate(
        buildUser('CLIENT_USER'),
        'membership.manage',
        [m],
        { companyId: THE_COMPANY },
      ).allowed,
    ).toBe(false);
  });

  it('CONTRACTOR cannot manage memberships, integrations, or layouts (no capabilities)', () => {
    const m: MembershipSnapshot = {
      companyId: THE_COMPANY,
      role: 'FULL',
      expiresAt: null,
      revokedAt: null,
    };
    expect(
      PermissionService.evaluate(
        buildUser('CONTRACTOR'),
        'membership.manage',
        [m],
        { companyId: THE_COMPANY },
      ).allowed,
    ).toBe(false);
    expect(
      PermissionService.evaluate(
        buildUser('CONTRACTOR'),
        'integration.manage',
        [m],
      ).allowed,
    ).toBe(false);
  });
});
