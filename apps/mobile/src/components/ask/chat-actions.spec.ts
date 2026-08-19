import { ApiError } from '../../lib/api';
import { problemMessage } from './chat-actions';

/**
 * The extraction itself is `@weavestream/shared`'s and is tested there.
 * What is mobile-only — and what these cases pin — is the `ApiError`
 * unwrap: the shared helper takes `unknown`, so handing it `err` instead
 * of `err.problem` typechecks cleanly and then returns the fallback for
 * every error. The first case is the one that fails if that regresses.
 */

const FALLBACK = 'Couldn’t apply the change.';

describe('problemMessage', () => {
  it('reads the problem body off an ApiError, not the error object', () => {
    const err = new ApiError(409, { detail: 'Folder is not empty' });
    expect(problemMessage(err, FALLBACK)).toBe('Folder is not empty');
  });

  it('keeps the shared detail → message → title precedence', () => {
    expect(
      problemMessage(new ApiError(400, { message: 'msg', title: 'Bad Request' }), FALLBACK),
    ).toBe('msg');
    expect(problemMessage(new ApiError(400, { title: 'Bad Request' }), FALLBACK)).toBe(
      'Bad Request',
    );
  });

  it('falls back when the problem body carries no usable string', () => {
    expect(problemMessage(new ApiError(500, undefined), FALLBACK)).toBe(FALLBACK);
    expect(problemMessage(new ApiError(500, { detail: '   ' }), FALLBACK)).toBe(FALLBACK);
  });

  it('falls back for anything that is not an ApiError', () => {
    expect(problemMessage(new Error('boom'), FALLBACK)).toBe(FALLBACK);
    expect(problemMessage({ detail: 'not an ApiError' }, FALLBACK)).toBe(FALLBACK);
    expect(problemMessage(undefined, FALLBACK)).toBe(FALLBACK);
  });
});
