import { escapeLikePattern } from './like-pattern.js';

describe('escapeLikePattern', () => {
  it('leaves plain text unchanged', () => {
    expect(escapeLikePattern('5CD1234XYZ 10.0.4.17')).toBe('5CD1234XYZ 10.0.4.17');
  });

  it.each([
    ['ABC_123', 'ABC\\_123'],
    ['100%', '100\\%'],
    ['C:\\temp', 'C:\\\\temp'],
    ['%_\\', '\\%\\_\\\\'],
  ])('escapes %s', (input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });
});
