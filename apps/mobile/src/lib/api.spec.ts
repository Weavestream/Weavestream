import { ApiError, StepUpCancelledError, isRestrictedError } from './api';

describe('isRestrictedError', () => {
  const stepUpProblem = { status: 403, code: 'step_up_required', factor: 'password' };

  it('matches a 403 that is neither a step-up demand nor a step-up cancel', () => {
    expect(isRestrictedError(new ApiError(403, { detail: 'not on allow-list' }))).toBe(true);
    expect(isRestrictedError(new ApiError(403, stepUpProblem))).toBe(false);
    expect(isRestrictedError(new StepUpCancelledError(stepUpProblem))).toBe(false);
    expect(isRestrictedError(new ApiError(404, null))).toBe(false);
    expect(isRestrictedError(new Error('x'))).toBe(false);
  });
});
