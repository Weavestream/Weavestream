import { stripTrailingSlashes } from './strip-trailing-slashes';

describe('stripTrailingSlashes', () => {
  it('removes one or many trailing slashes', () => {
    expect(stripTrailingSlashes('https://api.example.com/v1/')).toBe(
      'https://api.example.com/v1',
    );
    expect(stripTrailingSlashes('https://api.example.com/v1///')).toBe(
      'https://api.example.com/v1',
    );
  });

  it('leaves inner slashes and slash-free input alone', () => {
    expect(stripTrailingSlashes('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1',
    );
    expect(stripTrailingSlashes('a//b')).toBe('a//b');
    expect(stripTrailingSlashes('')).toBe('');
    expect(stripTrailingSlashes('///')).toBe('');
  });

  it('stays linear on a long slash run that does not end the input', () => {
    const hostile = `${'/'.repeat(200_000)}x`;
    const started = Date.now();
    expect(stripTrailingSlashes(hostile)).toBe(hostile);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
