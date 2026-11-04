import { ForbiddenException } from '@nestjs/common';
import type { MembershipPasswordAccess } from '@weavestream/shared';
import type { Request } from 'express';
import { MembershipsController } from './memberships.controller.js';
import { MembershipsCompanyController } from './memberships-company.controller.js';
import { membershipChangeNeedsStepUp } from './membership-step-up.js';
import { StepUpRequiredException } from '../auth/step-up/step-up-required.exception.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { FULL_PASSWORD_ACCESS } from '../passwords/password-access-policy.js';

const MEMBERSHIP_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const EXPIRY = new Date('2027-01-01T00:00:00.000Z');
const OTHER_EXPIRY = '2027-02-01T00:00:00.000Z';

const USER: AuthedUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  role: 'SUPER_ADMIN',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
  passwordAccess: FULL_PASSWORD_ACCESS,
};
const REQ = { headers: {}, ip: '127.0.0.1' } as unknown as Request;

const state = (passwordAccess: MembershipPasswordAccess, expiresAt: Date | null = null) => ({
  passwordAccess,
  expiresAt,
});

describe('membershipChangeNeedsStepUp', () => {
  it.each<[string, ReturnType<typeof state> | null, Parameters<typeof membershipChangeNeedsStepUp>[1], boolean]>([
    // Create
    ['create with allow', null, { userId: 'u', role: 'FULL', passwordAccess: 'allow' }, true],
    ['create with deny', null, { userId: 'u', role: 'FULL', passwordAccess: 'deny' }, true],
    ['create with inherit', null, { userId: 'u', role: 'FULL', passwordAccess: 'inherit' }, false],
    ['create without the field', null, { userId: 'u', role: 'FULL' }, false],
    // Update: password access itself
    ['inherit → allow', state('inherit'), { passwordAccess: 'allow' }, true],
    ['deny → inherit', state('deny'), { passwordAccess: 'inherit' }, true],
    ['allow → deny', state('allow'), { passwordAccess: 'deny' }, true],
    ['unchanged allow sent again', state('allow'), { passwordAccess: 'allow' }, false],
    // Update: lifecycle of an override
    ['expiry moved on allow', state('allow', EXPIRY), { expiresAt: OTHER_EXPIRY }, true],
    ['expiry cleared on deny', state('deny', EXPIRY), { expiresAt: null }, true],
    ['expiry added on allow', state('allow'), { expiresAt: OTHER_EXPIRY }, true],
    ['same expiry sent again on allow', state('allow', EXPIRY), { expiresAt: EXPIRY.toISOString() }, false],
    ['expiry moved on inherit', state('inherit', EXPIRY), { expiresAt: OTHER_EXPIRY }, false],
    // Update: role only
    ['role-only edit on deny', state('deny'), { role: 'READONLY' }, false],
    ['role-only edit on inherit', state('inherit'), { role: 'READONLY' }, false],
    // Revoke
    ['revoke allow', state('allow'), 'revoke', true],
    ['revoke deny', state('deny'), 'revoke', true],
    ['revoke inherit', state('inherit'), 'revoke', false],
  ])('%s → %s', (_label, current, change, expected) => {
    expect(membershipChangeNeedsStepUp(current, change as never)).toBe(expected);
  });
});

/**
 * The service mock does what the real service does: run the gate on the
 * (locked) current row, then write. `writes` records only completed writes.
 */
function makeDeps(
  current: { passwordAccess: string; expiresAt: Date | null },
  { verified }: { verified: boolean },
) {
  const writes: string[] = [];
  const state = { passwordAccess: current.passwordAccess as MembershipPasswordAccess, expiresAt: current.expiresAt };
  const memberships = {
    create: jest.fn(async () => {
      writes.push('create');
      return { id: MEMBERSHIP_ID };
    }),
    update: jest.fn(async (...args: unknown[]) => {
      await (args[4] as (s: typeof state) => Promise<void>)(state);
      writes.push('update');
      return { id: MEMBERSHIP_ID };
    }),
    revoke: jest.fn(async (...args: unknown[]) => {
      await (args[3] as (s: typeof state) => Promise<void>)(state);
      writes.push('revoke');
      return { ok: true };
    }),
  };
  const permissions = { can: jest.fn().mockResolvedValue({ allowed: true }) };
  const prisma = {
    membership: {
      findUnique: jest.fn().mockResolvedValue({ companyId: COMPANY_ID }),
    },
  };
  const stepUp = {
    assertVerified: jest.fn(async () => {
      if (!verified) throw new StepUpRequiredException('mfa');
    }),
  };
  const controller = new MembershipsController(
    memberships as never,
    permissions as never,
    prisma as never,
    stepUp as never,
  );
  const companyController = new MembershipsCompanyController(memberships as never, stepUp as never);
  return { controller, companyController, memberships, permissions, stepUp, writes };
}

describe('MembershipsController step-up', () => {
  it.each<[string, { passwordAccess: string; expiresAt: Date | null }, Record<string, unknown>]>([
    ['a password access change', { passwordAccess: 'inherit', expiresAt: null }, { passwordAccess: 'deny' }],
    ['an expiry change on allow', { passwordAccess: 'allow', expiresAt: EXPIRY }, { expiresAt: OTHER_EXPIRY }],
  ])('rejects %s without step-up and writes nothing', async (_label, current, dto) => {
    const { controller, writes } = makeDeps(current, { verified: false });
    await expect(controller.update(USER, MEMBERSHIP_ID, dto as never, REQ)).rejects.toBeInstanceOf(
      StepUpRequiredException,
    );
    expect(writes).toEqual([]);
  });

  it('updates after a verified step-up', async () => {
    const { controller, memberships, stepUp } = makeDeps(
      { passwordAccess: 'inherit', expiresAt: null },
      { verified: true },
    );
    await controller.update(USER, MEMBERSHIP_ID, { passwordAccess: 'allow' }, REQ);
    expect(stepUp.assertVerified).toHaveBeenCalledWith(USER);
    expect(memberships.update).toHaveBeenCalledWith(
      USER,
      MEMBERSHIP_ID,
      { passwordAccess: 'allow' },
      expect.anything(),
      expect.any(Function),
    );
  });

  it('does not ask for step-up on a role-only edit', async () => {
    const { controller, memberships, stepUp } = makeDeps(
      { passwordAccess: 'deny', expiresAt: null },
      { verified: false },
    );
    await controller.update(USER, MEMBERSHIP_ID, { role: 'READONLY' }, REQ);
    expect(stepUp.assertVerified).not.toHaveBeenCalled();
    expect(memberships.update).toHaveBeenCalled();
  });

  it('rejects the revoke of an override without step-up and writes nothing', async () => {
    const { controller, writes } = makeDeps(
      { passwordAccess: 'deny', expiresAt: null },
      { verified: false },
    );
    await expect(controller.revoke(USER, MEMBERSHIP_ID, REQ)).rejects.toBeInstanceOf(
      StepUpRequiredException,
    );
    expect(writes).toEqual([]);
  });

  it('revokes an inherit membership without step-up', async () => {
    const { controller, memberships, stepUp } = makeDeps(
      { passwordAccess: 'inherit', expiresAt: null },
      { verified: false },
    );
    await controller.revoke(USER, MEMBERSHIP_ID, REQ);
    expect(stepUp.assertVerified).not.toHaveBeenCalled();
    expect(memberships.revoke).toHaveBeenCalled();
  });

  it('checks membership.manage before the step-up decision', async () => {
    const { controller, permissions, stepUp, memberships } = makeDeps(
      { passwordAccess: 'deny', expiresAt: null },
      { verified: true },
    );
    permissions.can.mockResolvedValue({ allowed: false, reason: 'nope' });
    await expect(controller.revoke(USER, MEMBERSHIP_ID, REQ)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(stepUp.assertVerified).not.toHaveBeenCalled();
    expect(memberships.revoke).not.toHaveBeenCalled();
  });
});

describe('MembershipsCompanyController step-up', () => {
  it('rejects a create with an override without step-up and writes nothing', async () => {
    const { companyController, memberships, writes } = makeDeps(
      { passwordAccess: 'inherit', expiresAt: null },
      { verified: false },
    );
    await expect(
      companyController.create(
        USER,
        COMPANY_ID,
        { userId: 'u-2', role: 'FULL', passwordAccess: 'allow' } as never,
        REQ,
      ),
    ).rejects.toBeInstanceOf(StepUpRequiredException);
    expect(memberships.create).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('creates an inherit membership without step-up', async () => {
    const { companyController, memberships, stepUp } = makeDeps(
      { passwordAccess: 'inherit', expiresAt: null },
      { verified: false },
    );
    await companyController.create(USER, COMPANY_ID, { userId: 'u-2', role: 'FULL' } as never, REQ);
    expect(stepUp.assertVerified).not.toHaveBeenCalled();
    expect(memberships.create).toHaveBeenCalled();
  });
});
