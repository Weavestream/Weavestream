import { UnauthorizedException } from '@nestjs/common';
import {
  CURRENT_PASSWORD_INVALID_CODE,
  isCurrentPasswordInvalidProblem,
} from '@weavestream/shared';
import { ProblemExceptionFilter } from './problem-exception.filter.js';

/**
 * The wire contract for the change-password 401 discriminator.
 *
 * `POST /me/change-password` 401s for two unrelated reasons — the supplied
 * current password was wrong (`MeService.changePassword`) or the session is
 * gone (`AuthGuard`, a bare `UnauthorizedException` raised after
 * `silentRefresh` already failed). A client that cannot tell them apart
 * either sends a signed-out technician back to retype a correct password
 * forever, or signs them out over a single typo.
 *
 * The service-level payload is pinned in `me.service.spec.ts`; these cases
 * pin what actually reaches the client, because the distinction only holds
 * if this filter both (a) spreads `code` onto the body as an RFC-7807
 * extension member and (b) leaves the guard's bare 401 without one. Asserted
 * through the shared narrowing helper — the same predicate both clients
 * branch on — rather than by reading `body.code` directly.
 */

function captureBody(exception: unknown): Record<string, unknown> {
  let body: Record<string, unknown> | undefined;
  const res = {
    status: jest.fn(),
    setHeader: jest.fn(),
    json: (payload: Record<string, unknown>) => {
      body = payload;
    },
  };
  const req = { originalUrl: '/api/v1/me/change-password', method: 'POST', id: 'req-1' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as never;
  const logger = { error: jest.fn(), warn: jest.fn() } as never;

  new ProblemExceptionFilter(logger).catch(exception, host);
  if (!body) throw new Error('filter did not write a body');
  return body;
}

describe('ProblemExceptionFilter — change-password 401 discriminator', () => {
  it('spreads the code onto the body and keeps detail human-readable', () => {
    const body = captureBody(
      new UnauthorizedException({
        message: 'Current password is incorrect',
        code: CURRENT_PASSWORD_INVALID_CODE,
      }),
    );

    expect(body.status).toBe(401);
    expect(body.code).toBe(CURRENT_PASSWORD_INVALID_CODE);
    // `detail` is what pre-existing consumers render; adding the code must
    // not have changed it.
    expect(body.detail).toBe('Current password is incorrect');
    expect(isCurrentPasswordInvalidProblem(body)).toBe(true);
  });

  it('leaves the guard-style bare 401 without a code', () => {
    const body = captureBody(new UnauthorizedException());

    expect(body.status).toBe(401);
    expect(body.code).toBeUndefined();
    // The negative half of the contract: a dead session must NOT read as a
    // rejected password, or a client would keep the user on the form.
    expect(isCurrentPasswordInvalidProblem(body)).toBe(false);
  });
});
