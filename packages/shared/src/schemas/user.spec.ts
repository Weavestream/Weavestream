import {
  CURRENT_PASSWORD_INVALID_CODE,
  isCurrentPasswordInvalidProblem,
} from './user.js';

/**
 * The narrowing half of the change-password 401 discriminator. Both clients
 * branch on this predicate to decide between "stay on the form, the field
 * was wrong" and "the session is gone, route to login", so it has to be
 * strict: anything that is not an object carrying exactly this code must
 * read as false, or a dead session gets mistaken for a typo.
 */
describe('isCurrentPasswordInvalidProblem', () => {
  it('accepts a problem body carrying the code', () => {
    expect(
      isCurrentPasswordInvalidProblem({
        status: 401,
        detail: 'Current password is incorrect',
        code: CURRENT_PASSWORD_INVALID_CODE,
      }),
    ).toBe(true);
  });

  it('rejects bodies without the code, including other coded 401s', () => {
    // The guard's bare 401 — no `code` at all.
    expect(isCurrentPasswordInvalidProblem({ status: 401, detail: 'Unauthorized' })).toBe(
      false,
    );
    // A different stable code must not collide.
    expect(
      isCurrentPasswordInvalidProblem({ status: 403, code: 'step_up_required' }),
    ).toBe(false);
    // Matching on `detail` prose is exactly what the code exists to replace.
    expect(
      isCurrentPasswordInvalidProblem({ detail: 'Current password is incorrect' }),
    ).toBe(false);
  });

  it('rejects non-object inputs without throwing', () => {
    for (const value of [null, undefined, '', CURRENT_PASSWORD_INVALID_CODE, 0, []]) {
      expect(isCurrentPasswordInvalidProblem(value)).toBe(false);
    }
  });
});
