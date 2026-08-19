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

  it('returns null for non-objects', () => {
    for (const v of [null, undefined, 'a string', 42, true]) {
      expect(problemMessage(v)).toBeNull();
    }
  });
});
