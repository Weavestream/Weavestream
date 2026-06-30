import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StepUpGuard } from './step-up.guard.js';
import { StepUpRequiredException } from './step-up-required.exception.js';
import { REQUIRE_STEP_UP_KEY } from './require-step-up.decorator.js';
import type { StepUpService } from './step-up.service.js';
import type { RequireStepUpMetadata } from './require-step-up.decorator.js';

function makeCtx(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as unknown as ExecutionContext;
}

function makeGuard(
  meta: RequireStepUpMetadata | undefined,
  stepUp: Partial<StepUpService>,
) {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key) =>
      key === REQUIRE_STEP_UP_KEY ? meta : undefined,
    );
  return new StepUpGuard(reflector, stepUp as StepUpService);
}

const VERIFIED = {
  isVerified: jest.fn().mockResolvedValue(true),
  requiredFactor: jest.fn().mockResolvedValue('mfa'),
};
const UNVERIFIED = {
  isVerified: jest.fn().mockResolvedValue(false),
  requiredFactor: jest.fn().mockResolvedValue('mfa'),
};

describe('StepUpGuard', () => {
  const user = { id: 'u-1', sessionId: 's-1', mfaPending: false };

  it('allows routes without @RequireStepUp metadata', async () => {
    const g = makeGuard(undefined, UNVERIFIED);
    await expect(g.canActivate(makeCtx({ user }))).resolves.toBe(true);
    expect(UNVERIFIED.isVerified).not.toHaveBeenCalled();
  });

  it('skips the challenge when the predicate returns false', async () => {
    const isVerified = jest.fn().mockResolvedValue(false);
    const g = makeGuard({ when: () => false }, {
      isVerified,
      requiredFactor: jest.fn().mockResolvedValue('mfa'),
    });
    await expect(
      g.canActivate(makeCtx({ user, body: { name: 'x' } })),
    ).resolves.toBe(true);
    expect(isVerified).not.toHaveBeenCalled();
  });

  it('challenges when the predicate returns true and not verified', async () => {
    const g = makeGuard({ when: () => true }, UNVERIFIED);
    await expect(
      g.canActivate(makeCtx({ user, body: { role: 'OPERATOR' } })),
    ).rejects.toBeInstanceOf(StepUpRequiredException);
  });

  it('allows when the session has a valid step-up window', async () => {
    const g = makeGuard({}, VERIFIED);
    await expect(g.canActivate(makeCtx({ user }))).resolves.toBe(true);
  });

  it('challenges an unverified session and reports the required factor', async () => {
    const g = makeGuard({}, UNVERIFIED);
    await expect(g.canActivate(makeCtx({ user }))).rejects.toMatchObject({
      response: { code: 'step_up_required', factor: 'mfa' },
    });
  });

  it('challenges an MFA-pending session without consulting the window', async () => {
    const isVerified = jest.fn().mockResolvedValue(true);
    const g = makeGuard({}, {
      isVerified,
      requiredFactor: jest.fn().mockResolvedValue('password'),
    });
    await expect(
      g.canActivate(makeCtx({ user: { ...user, mfaPending: true } })),
    ).rejects.toBeInstanceOf(StepUpRequiredException);
    // `||` short-circuits: an mfaPending session never even reads the key.
    expect(isVerified).not.toHaveBeenCalled();
  });

  it('rejects when there is no authenticated user', async () => {
    const g = makeGuard({}, UNVERIFIED);
    await expect(g.canActivate(makeCtx({}))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
