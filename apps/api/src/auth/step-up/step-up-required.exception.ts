import { ForbiddenException } from '@nestjs/common';
import type { StepUpFactor } from '@weavestream/shared';

/**
 * Thrown by `StepUpGuard` when a sensitive route is hit without a valid
 * recent step-up.
 *
 * `ProblemExceptionFilter` spreads the `code` and `factor` members onto
 * the RFC-7807 problem body as extension fields, so the web client can
 * distinguish this from an ordinary permission denial (which carries no
 * `code`) and prompt for the right credential. `message` is consumed by
 * the filter as the human-readable `detail`.
 */
export class StepUpRequiredException extends ForbiddenException {
  constructor(factor: StepUpFactor) {
    super({
      message: 'Step-up authentication required',
      code: 'step_up_required',
      factor,
    });
  }
}
