import type { Request } from 'express';
import { MembershipsController } from './memberships.controller.js';
import { MembershipsCompanyController } from './memberships-company.controller.js';
import { MembershipsService } from './memberships.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConflictException } from '@nestjs/common';
import { StepUpRequiredException } from '../auth/step-up/step-up-required.exception.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { FULL_PASSWORD_ACCESS } from '../passwords/password-access-policy.js';

/**
 * Review finding: the step-up decision for a membership change must see
 * the row that the write changes. Before the fix, the controller read the
 * row, decided "no step-up", and the write came later. A concurrent
 * change between the 2 (for example to `deny`) was then overwritten or
 * revoked without step-up.
 *
 * Each case holds the membership row lock in transaction B, changes the
 * row, and starts request A while B is still open. A must wait for B,
 * see B's committed value, and ask for step-up. With the old code A
 * decided on the stale value and wrote without step-up.
 *
 * Opt-in via `WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1`: without the flag
 * this spec would write to the configured development database. Every
 * row it writes uses the ids below and is removed in `afterAll`. Run with:
 *   WEAVESTREAM_RUN_DB_INTEGRATION_TESTS=1 pnpm --filter @weavestream/api test memberships.step-up-race.db
 */
const describeIfDb =
  process.env.WEAVESTREAM_RUN_DB_INTEGRATION_TESTS === '1' ? describe : describe.skip;

const id = (suffix: string) => `6bd00000-0000-4000-8000-${suffix.padStart(12, '0')}`;

const ADMIN_ID = id('a001');
const MEMBER_ID = id('a002');
const COMPANY = id('c001');
const MEMBERSHIP = id('d001');

/** How long B keeps the lock after A has started. */
const HOLD_MS = 300;

const ADMIN: AuthedUser = {
  id: ADMIN_ID,
  email: 'membership-race-spec-admin@example.com',
  role: 'SUPER_ADMIN',
  globalAccess: 'FULL',
  platformCapabilities: [],
  sessionId: id('e001'),
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
  passwordAccess: FULL_PASSWORD_ACCESS,
} as AuthedUser;

const REQ = { headers: {}, ip: '127.0.0.1' } as unknown as Request;

describeIfDb('membership step-up decision vs concurrent change (DB integration)', () => {
  const prisma = new PrismaService();
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const service = new MembershipsService(prisma, audit as never, cache as never);
  // The admin has NOT completed step-up in this session.
  const stepUp = {
    assertVerified: jest.fn(async () => {
      throw new StepUpRequiredException('mfa');
    }),
  };
  const controller = new MembershipsController(
    service,
    { can: jest.fn().mockResolvedValue({ allowed: true }) } as never,
    prisma,
    stepUp as never,
  );

  const companyController = new MembershipsCompanyController(service, stepUp as never);

  async function setMembership(passwordAccess: 'inherit' | 'allow' | 'deny') {
    await prisma.membership.update({
      where: { id: MEMBERSHIP },
      data: { passwordAccess, revokedAt: null, expiresAt: null },
    });
  }

  /**
   * B locks the row and sets `next`. While B is open, A starts. A must not
   * finish before B commits; A's result is returned after B commits.
   */
  async function raceAgainst<T>(
    next: 'allow' | 'deny',
    requestA: () => Promise<T>,
  ): Promise<{ settledWhileLocked: boolean; result: PromiseSettledResult<T> }> {
    let settled = false;
    let a!: Promise<PromiseSettledResult<T>>;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "memberships" WHERE "id" = ${MEMBERSHIP}::uuid FOR UPDATE`;
      await tx.membership.update({ where: { id: MEMBERSHIP }, data: { passwordAccess: next } });
      a = requestA().then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, HOLD_MS));
    });
    const settledWhileLocked = settled;
    return { settledWhileLocked, result: await a };
  }

  async function cleanup() {
    await prisma.company.deleteMany({ where: { id: COMPANY } });
    await prisma.user.deleteMany({ where: { id: { in: [ADMIN_ID, MEMBER_ID] } } });
  }

  beforeAll(async () => {
    await prisma.$connect();
    await cleanup();
    await prisma.user.createMany({
      data: [
        {
          id: ADMIN_ID,
          email: 'membership-race-spec-admin@example.com',
          name: 'Membership Race Spec Admin',
          passwordHash: 'x',
          role: 'SUPER_ADMIN',
        },
        {
          id: MEMBER_ID,
          email: 'membership-race-spec-member@example.com',
          name: 'Membership Race Spec Member',
          passwordHash: 'x',
          role: 'OPERATOR',
          globalAccess: 'FULL',
        },
      ],
    });
    await prisma.company.create({
      data: { id: COMPANY, name: 'Membership Race Spec', slug: 'membership-race-spec' },
    });
    await prisma.membership.create({
      data: { id: MEMBERSHIP, userId: MEMBER_ID, companyId: COMPANY, role: 'FULL' },
    });
  });

  beforeEach(() => {
    stepUp.assertVerified.mockClear();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('an update that was a no-op on the old row asks for step-up after a concurrent deny', async () => {
    // A re-sends `allow` on an `allow` row: no step-up on that row. B changes
    // the row to `deny` first, so A would now restore access.
    await setMembership('allow');
    const { settledWhileLocked, result } = await raceAgainst('deny', () =>
      controller.update(ADMIN, MEMBERSHIP, { passwordAccess: 'allow' }, REQ),
    );

    expect(settledWhileLocked).toBe(false);
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(StepUpRequiredException);
    expect(stepUp.assertVerified).toHaveBeenCalledTimes(1);
    const row = await prisma.membership.findUniqueOrThrow({ where: { id: MEMBERSHIP } });
    expect(row.passwordAccess).toBe('deny');
  });

  it('a revoke of an inherit row asks for step-up after a concurrent deny', async () => {
    // A revokes an `inherit` row: no step-up on that row. B changes the row
    // to `deny` first, so the revoke would now give access back.
    await setMembership('inherit');
    const { settledWhileLocked, result } = await raceAgainst('deny', () =>
      controller.revoke(ADMIN, MEMBERSHIP, REQ),
    );

    expect(settledWhileLocked).toBe(false);
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(StepUpRequiredException);
    const row = await prisma.membership.findUniqueOrThrow({ where: { id: MEMBERSHIP } });
    expect(row.revokedAt).toBeNull();
    expect(row.passwordAccess).toBe('deny');
  });

  it('a reactivation with inherit cannot overwrite a concurrent reactivation with deny', async () => {
    // The row is revoked. Request A re-adds the member with `inherit` (no
    // step-up) and reads the revoked row. Before A writes, request B
    // reactivates the same row with `deny` (after step-up) and commits.
    // A must not write `inherit` over B's active `deny`.
    await prisma.membership.update({
      where: { id: MEMBERSHIP },
      data: { revokedAt: new Date(), passwordAccess: 'inherit', role: 'FULL' },
    });

    let settled = false;
    let a!: Promise<PromiseSettledResult<unknown>>;
    await prisma.$transaction(async (tx) => {
      // B: lock and reactivate with deny, but do not commit yet.
      await tx.$queryRaw`SELECT 1 FROM "memberships" WHERE "id" = ${MEMBERSHIP}::uuid FOR UPDATE`;
      await tx.membership.update({
        where: { id: MEMBERSHIP },
        data: { revokedAt: null, passwordAccess: 'deny', role: 'READONLY' },
      });
      // A: sees the committed (still revoked) row, then blocks on B's lock.
      a = companyController
        .create(ADMIN, COMPANY, { userId: MEMBER_ID, role: 'FULL' }, REQ)
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((r) => setTimeout(r, HOLD_MS));
    });
    expect(settled).toBe(false);
    const result = await a;

    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(stepUp.assertVerified).not.toHaveBeenCalled();
    const row = await prisma.membership.findUniqueOrThrow({ where: { id: MEMBERSHIP } });
    expect(row.revokedAt).toBeNull();
    expect(row.passwordAccess).toBe('deny');
    expect(row.role).toBe('READONLY');
  });

  it('a role-only edit still goes through after a concurrent change, without step-up', async () => {
    await setMembership('inherit');
    const { result } = await raceAgainst('deny', () =>
      controller.update(ADMIN, MEMBERSHIP, { role: 'READONLY' }, REQ),
    );

    expect(result.status).toBe('fulfilled');
    expect(stepUp.assertVerified).not.toHaveBeenCalled();
    const row = await prisma.membership.findUniqueOrThrow({ where: { id: MEMBERSHIP } });
    expect(row.role).toBe('READONLY');
    expect(row.passwordAccess).toBe('deny');
  });
});
