import { problemMessage } from './problem';

describe('problemMessage', () => {
  it('prefers detail over message and title', () => {
    expect(
      problemMessage({ detail: 'Folder is not empty', message: 'msg', title: 'Conflict' }),
    ).toBe('Folder is not empty');
  });

  it('falls back to message when detail is absent', () => {
    expect(problemMessage({ message: 'msg', title: 'Conflict' })).toBe('msg');
  });

  it('falls back to title when detail and message are absent', () => {
    expect(problemMessage({ title: 'Conflict' })).toBe('Conflict');
  });

  it('skips blank strings and continues down the precedence', () => {
    expect(problemMessage({ detail: '', message: '   ', title: 'Conflict' })).toBe(
      'Conflict',
    );
  });

  it('preserves the original value, not the trimmed one', () => {
    expect(problemMessage({ detail: ' spaced ' })).toBe(' spaced ');
  });

  it('ignores non-string fields', () => {
    expect(problemMessage({ detail: 42, message: null, title: { nested: true } })).toBeNull();
  });

  it('never falls back to the title of a server error', () => {
    expect(problemMessage({ status: 500, title: 'Internal Server Error' })).toBeNull();
    expect(problemMessage({ status: 503, title: 'Error' })).toBeNull();
  });

  it('still shows the detail of a server error when one is sent', () => {
    expect(problemMessage({ status: 503, title: 'Error', detail: 'Backup worker offline' })).toBe(
      'Backup worker offline',
    );
  });

  it('falls back to the title of a client error', () => {
    expect(problemMessage({ status: 404, title: 'Not Found' })).toBe('Not Found');
  });

  it('shows the first validation issue instead of the ValidationError code', () => {
    expect(
      problemMessage({
        status: 400,
        title: 'Bad Request',
        detail: 'ValidationError',
        error: 'ValidationError',
        issues: [
          { path: 'recipients', message: 'Too many recipients (max 100)' },
          { path: 'name', message: 'Required' },
        ],
      }),
    ).toBe('Too many recipients (max 100)');
  });

  it('ignores an empty or malformed issues list', () => {
    expect(problemMessage({ detail: 'Bad input', issues: [] })).toBe('Bad input');
    expect(problemMessage({ detail: 'Bad input', issues: [{ message: 7 }] })).toBe('Bad input');
    expect(problemMessage({ detail: 'Bad input', issues: 'nope' })).toBe('Bad input');
  });

  it('returns null for non-objects', () => {
    for (const v of [null, undefined, 'a string', 42, true]) {
      expect(problemMessage(v)).toBeNull();
    }
  });
});
